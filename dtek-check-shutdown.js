// Reverse-engineered from https://www.dtek-dnem.com.ua/src/js/static/discon-schedule.js
import express from 'express'
import puppeteer from 'puppeteer'

process.env.TZ = 'Europe/Kiev'

function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * @param {Date} input
 * @param {boolean} noTime
 */
function formatDate(input, { noTime = false } = {}) {
  const [date, time] = input.toLocaleString('uk-UK', { timeZone: process.env.TZ }).split(', ')
  const [d, m, Y] = date.split('.')

  return `${Y}-${m}-${d}${noTime ? '' : ` ${time}`}`
}

function formatDateIcs(input) {
  // Handle hour 24 (midnight) by converting to next day 00:00.
  if (input.includes(' 24:')) {
    const [dateStr, timeStr] = input.split(' ')
    const date = new Date(dateStr)

    // Next day.
    date.setDate(date.getDate() + 1)

    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${timeStr.replace('24:', '00').replaceAll(':', '')}`
  }

  return input.replace(' ', 'T').replace(/[-:]/g, '')
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
        segments.push({ startsAt: h0, endsAt: h1 })
        break

      case 'first':
        segments.push({ startsAt: h0, endsAt: h30 })
        break

      case 'second':
        segments.push({ startsAt: h30, endsAt: h1 })
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

  await new Promise((r) => setTimeout(r, 50))
  await (await page.locator(inputSelector))
    .setWaitForEnabled(true)
    .fill(value)

  await (await page.waitForSelector(optionSelector)).click()
  await page.waitForFunction(
    (selector) => !!document.querySelector(selector)?.value,
    {},
    inputSelector,
  )
}

async function getShutdown(page, catchResponse, region, locality, street, building) {
  await page.goto(`https://www.dtek-${region}.com.ua/ua/shutdowns`)
  // Handle `Сайт працює, але через велике навантаження треба трохи зачекати і сторінка завантажиться.`.
  await page.waitForFunction(() => !!document.querySelector('.wrapper'), { timeout: 120_000 })
  // Don't show freaking modals.
  await page.addStyleTag({ content: '#modal-attention { display: none !important; }' })

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

async function collect(region, locality, street, building) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const [page] = await browser.pages()
  const data = await getShutdown(page, setupResponseCatcher(page), region, locality, street, building)

  console.debug(JSON.stringify(data, null, 4))
  await browser.close()

  return data
}

class Ics {
  constructor(name) {
    this.uid = 0
    this.uidPrefix = `${name.replace(/\W/g, '')}${new Date().toISOString()}`
    this.lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//DTEK ${name}//EN`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VTIMEZONE',
      `TZID:${process.env.TZ}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0200',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]
  }

  addEvent(updatedAt, startsAt, endsAt, summary, description) {
    this.lines.push(
      'BEGIN:VEVENT',
      `UID:${this.uidPrefix}@${this.uid++}`,
      `DTSTAMP:${formatDateIcs(updatedAt)}Z`,
      `DTSTART;TZID=${process.env.TZ}:${formatDateIcs(startsAt)}`,
      `DTEND;TZID=${process.env.TZ}:${formatDateIcs(endsAt)}`,
      `SUMMARY:${summary}`,
      ...(description ? [`DESCRIPTION:${description}`] : []),
      'END:VEVENT',
    )
  }

  toString() {
    return [...this.lines, 'END:VCALENDAR'].join('\r\n') + '\r\n'
  }
}

function buildIcs(region, data) {
  const ics = new Ics(`DTEK ${region.toUpperCase()} Outages ${data.group}`)

  for (const day of data.schedule.days) {
    for (const interval of day.intervals) {
      ics.addEvent(
        data.schedule.updatedAt,
        day.date + ' ' + interval.startsAt,
        day.date + ' ' + interval.endsAt,
        'Power outage',
      )
    }
  }

  if (data.shutdown) {
    ics.addEvent(
      data.shutdown.updatedAt,
      data.shutdown.startedAt,
      data.shutdown.endsAt,
      'Power outage',
      data.shutdown.reason,
    )
  }

  return ics
}

async function main() {
  const [,, region, locality, street, building] = process.argv
  const app = express()

  app.get('/dtek-shutdowns.ics', async (request, response) => {
    try {
      console.info(`[${new Date().toISOString()}] Collecting the data`)

      response.set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-cache',
      })

      response.send(String(buildIcs(region, await collect(region, locality, street, building))))

      console.info(`[${new Date().toISOString()}] Schedule published`)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Oops`, error)
      response.send(error.stack)
    }
  })

  app.listen(8086, '0.0.0.0')
}

main()
