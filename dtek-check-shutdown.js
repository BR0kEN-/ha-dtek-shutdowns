// Reverse-engineered from https://www.dtek-dnem.com.ua/src/js/static/discon-schedule.js
import puppeteer from 'puppeteer'
import { connectAsync as mqttConnectAsync } from 'mqtt'

/**
 * @param {Date} input
 * @param {boolean} noTime
 */
function formatDate(input, { noTime = false } = {}) {
  const [date, time] = input.toLocaleString('uk-UK', { timeZone: 'Europe/Kyiv' }).split(', ')
  const [d, m, Y] = date.split('.')

  return `${Y}-${m}-${d}${noTime ? '' : ` ${time}`}`
}

function formatDateTime(date, time) {
  const [d, m, Y] = date.split('.')

  return formatDate(new Date(`${Y}-${m}-${d} ${time}`))
}

function fixDateTime(input) {
  return formatDateTime(...input.split(' '))
}

function fixTimeDate(input) {
  const [time, date] = input.split(' ')

  return formatDateTime(date, time)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function buildIntervals(hours) {
  const segments = []
  const intervals = []

  for (let h = 1; h <= 24; h++) {
    const startHour = h - 1
    const h1 = `${pad(h)}:00:00`
    const h0 = `${pad(startHour)}:00:00`
    const h30 = `${pad(startHour)}:30:00`

    switch (hours[h]) {
      case 'no':
        segments.push({ state: 'outage', startsAt: h0, endsAt: h1 })
        break

      case 'first':
        segments.push({ state: 'outage', startsAt: h0, endsAt: h30 })
        break

      case 'second':
        segments.push({ state: 'outage', startsAt: h30, endsAt: h1 })
        break
    }
  }

  for (const s of segments) {
    const last = intervals.at(-1)

    if (last && last.state === s.state && last.endsAt === s.startsAt) {
      last.endsAt = s.endsAt
    } else {
      intervals.push({ ...s })
    }
  }

  return intervals
}

function setupResponseCatcher(page) {
  let resolve

  page.on('response', async (response) => {
    const url = response.url()

    if (url.endsWith('/ua/ajax')) {
      resolve?.(await response.json())
    }
  })

  return () => new Promise((_resolve) => {
    resolve = _resolve
  })
}

async function fillAutocomplete(page, name, value) {
  const inputSelector = `input[name=${name}]`
  const optionSelector = `${inputSelector} ~ .autocomplete-items > div`

  await (await page.locator(inputSelector))
    .setWaitForEnabled(true)
    .fill(value)

  await (await page.waitForSelector(optionSelector)).click()
}

async function getShutdown(page, catchResponse, region, locality, street, building) {
  await page.goto(`https://www.dtek-${region}.com.ua/ua/shutdowns`)

  try {
    await (await page.waitForSelector('#modal-attention', { timeout: 1000 })).evaluate((node) => node.remove())
  } catch {
  }

  const detailsResponse = catchResponse()
  await fillAutocomplete(page, 'city', locality)
  await fillAutocomplete(page, 'street', street)
  await fillAutocomplete(page, 'house_num', building)

  const { updateTimestamp, data: { [building]: data } } = await detailsResponse
  const { group, schedule } = await page.evaluate(() => {
    const { group, fact } = DisconSchedule
    const schedule = {
      updatedAt: fact.update,
      days: [],
    }

    for (const [timestamp, groups] of Object.entries(fact.data)) {
      schedule.days.push({
        timestamp: Number(timestamp),
        hours: groups[group],
      })
    }

    return {
      group: parseFloat(group.replace(/[^\d.]+/, '')),
      schedule,
    }
  })
  const result = {
    group,
    shutdown: null,
    schedule: {
      updatedAt: fixDateTime(schedule.updatedAt),
      days: schedule.days.map(({ timestamp, hours }) => ({
        date: formatDate(new Date(timestamp * 1000), { noTime: true }),
        intervals: buildIntervals(hours),
      })),
    },
  }

  if (data?.type) {
    result.shutdown = {
      updatedAt: fixTimeDate(updateTimestamp),
      startedAt: fixTimeDate(data.start_date),
      endsAt: fixTimeDate(data.end_date),
      reason: (() => {
        switch (Number(data.type)) {
          case 1:
            return 'Планові ремонтні роботи'

          case 2:
            return data.sub_type

          default:
            return 'Unknown'
        }
      })(),
    }
  }

  return result
}

async function collect(mqtt, region, locality, street, building) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const [page] = await browser.pages()
  const [mqttClient, data] = await Promise.all([
    mqtt,
    getShutdown(page, setupResponseCatcher(page), region, locality, street, building),
  ])

  console.debug(JSON.stringify(data, null, 4))

  await Promise.all([
    mqttClient.publishAsync(
      'dtek/power/outages/schedule',
      JSON.stringify(data),
      {
        qos: 1,
        retain: false,
      },
    ),
    browser.close()
  ])
}

async function main() {
  const [,, region, locality, street, building, mqttUrl, interval] = process.argv
  const timeout = Number(interval) * 60 * 1000
  const mqtt = mqttConnectAsync(mqttUrl, { clean: true })

  // noinspection InfiniteLoopJS
  while (true) {
    try {
      console.info(`[${new Date().toISOString()}] Collecting the data`)
      await collect(mqtt, region, locality, street, building)
      console.info(`[${new Date().toISOString()}] Schedule published`)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Oops`, error)
    }

    await new Promise((r) => setTimeout(r, timeout))
  }
}

main()
