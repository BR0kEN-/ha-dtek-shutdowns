// Reverse-engineered from https://www.dtek-dnem.com.ua/src/js/static/discon-schedule.js
import { writeFileSync } from 'node:fs'
import express from 'express'
import puppeteer from 'puppeteer'

process.env.TZ = 'Europe/Kyiv'

/**
 * @param {Date} input
 * @param {boolean} noTime
 */
function formatDate(input, { noTime = false } = {}) {
  const [date, time] = input.toLocaleString('uk-UK', { timeZone: process.env.TZ }).split(', ')
  const [d, m, Y] = date.split('.')

  return `${Y}-${m}-${d}${noTime ? '' : ` ${time}`}`
}

/**
 * @param {Date} input
 * @return {string}
 */
function formatDateIcs(input) {
  return formatDate(input)
    .replace(' ', 'T')
    .replace(/[-:]/g, '')
}

/**
 * @param {string} date
 * @param {string} [time]
 * @return {Date}
 */
function toDatetime(date, time) {
  if (time === undefined && date.includes(' ')) {
    const [a, b] = date.split(' ')

    if (a.includes(':')) {
      date = b
      time = a
    } else {
      date = a
      time = b
    }
  }

  const [d, m, Y] = date.split('.')

  return new Date(`${Y}-${m}-${d} ${time}`)
}

function buildIntervals(days) {
  const intervals = []

  for (const { timestamp, hours } of days) {
    const dayStart = new Date(timestamp * 1000)
    dayStart.setHours(0, 0, 0, 0)

    for (let h = 1; h <= 24; h++) {
      const startMin = (h - 1) * 60
      const endMin = h * 60
      const half = startMin + 30
      let seg = null

      switch (hours[h]) {
        case 'no':
          seg = { startMin, endMin }
          break

        case 'first':
          seg = { startMin, endMin: half }
          break

        case 'second':
          seg = { startMin: half, endMin }
          break

        default:
          continue
      }

      const start = new Date(dayStart)
      start.setMinutes(start.getMinutes() + seg.startMin)

      const end = new Date(dayStart)
      end.setMinutes(end.getMinutes() + seg.endMin)

      const last = intervals.at(-1)

      // Merge contiguous outages (including across midnight).
      if (last && last.end.getTime() === start.getTime()) {
        last.end = end
      } else {
        intervals.push({ start, end })
      }
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
      updatedAt: toDatetime(schedule.updatedAt),
      events: buildIntervals(schedule.days),
    },
  }

  if (data?.type) {
    result.shutdown = {
      updatedAt: toDatetime(updateTimestamp),
      startedAt: toDatetime(data.start_date),
      endsAt: toDatetime(data.end_date),
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

async function getBrowser(region, cookies) {
  const domain = `.dtek-${region}.com.ua`
  const browser = await puppeteer.launch({
    headless: !!process.env.PUPPETEER_EXECUTABLE_PATH,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  })


  await browser.setCookie(
    cookies.map(({ name, value }) => ({
      name,
      value,
      domain,
      secure: true,
      httpOnly: true,
      sameSite: 'None',
    })),
  )

  return browser
}

async function collect(browser, region, locality, street, building) {
  const page = await browser.newPage()

  try {
    const data = await getShutdown(page, setupResponseCatcher(page), region, locality, street, building)

    console.debug(JSON.stringify(data, null, 4))

    return data
  } finally {
    await page.close()
  }
}

class Ics {
  constructor(name) {
    const now = new Date()

    this.uid = 0
    this.uidPrefix = `${name.replace(/\W/g, '')}${now.toISOString()}`
    this.refreshDate = formatDate(now)
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

  /**
   * @param {string} summary
   * @param {Date} updatedAt
   * @param {Date} startsAt
   * @param {Date} endsAt
   * @param {string} location
   * @param {string} [description]
   */
  addEvent(summary, updatedAt, startsAt, endsAt, location, description) {
    if (description) {
      description += '\n'
    } else {
      description = ''
    }

    description += `Updated at ${formatDate(updatedAt)}`
    description += `\nRefreshed at ${this.refreshDate}`

    this.lines.push(
      'BEGIN:VEVENT',
      `UID:${this.uidPrefix}@${this.uid++}`,
      `DTSTAMP:${formatDateIcs(updatedAt)}Z`,
      `DTSTART;TZID=${process.env.TZ}:${formatDateIcs(startsAt)}`,
      `DTEND;TZID=${process.env.TZ}:${formatDateIcs(endsAt)}`,
      `SUMMARY:${this.escapeIcsText(summary)}`,
      `LOCATION:${this.escapeIcsText(location)}`,
      `DESCRIPTION:${this.escapeIcsText(description)}`,
      'END:VEVENT',
    )
  }

  escapeIcsText(text) {
    return text
      // Backslash first!
      .replaceAll('\\', '\\\\')
      .replaceAll(';', '\\;')
      .replaceAll(',', '\\,')
      .replaceAll('\n', '\\n')
  }

  toString() {
    return [...this.lines, 'END:VCALENDAR'].join('\r\n') + '\r\n'
  }
}

function buildIcs(region, location, data) {
  const ics = new Ics(`DTEK ${region.toUpperCase()} Outages ${data.group}`)
  const eventName = `Power outage (group ${data.group})`

  for (const event of data.schedule.events) {
    ics.addEvent(
      eventName,
      data.schedule.updatedAt,
      event.start,
      event.end,
      location,
    )
  }

  return ics
}

async function main() {
  const [,, region, locality, street, building, incapsula, options] = process.argv
  console.log(
    incapsula,
  );
  const browser = await getBrowser(region, [
    {
      name: 'visid_incap_2224656',
      value: 'mWMC4fLzS0qFQKkzr96vqy0bgmkAAAAAQUIPAAAAAABd6KQjPcPN1O+ILZy75q9m',
    },
    {
      name: 'incap_ses_540_2224656',
      value: 'HF93M0AOtz4JP2kwYHd+By0bgmkAAAAAHb5Q4Zs3xBtdMX6kxfjV6Q==',
    },
  ])
  const app = express()
  let pendingResponses = []
  let prevResult
  let promise

  function storeOutageMetadata(metadata) {
    if (options?.includes('store-metadata')) {
      try {
        writeFileSync('/share/dtek-outage-metadata.json', JSON.stringify(metadata), 'utf-8')
      } catch (error) {
        console.error('Failed to write outage metadata file', error)
      }
    }
  }

  async function query(response, contentType) {
    const reqId = Math.random().toString(36).substring(7)
    console.info(`[${reqId}] Request received at ${new Date().toISOString()}`)

    pendingResponses.push({ response, contentType, reqId })
    console.info(`[${reqId}] Queue size: ${pendingResponses.length}`)

    if (promise) {
      console.info(`[${reqId}] Reusing existing collection promise`)
    } else {
      console.info(`[${reqId}] Starting new collection...`)
      promise = collect(browser, region, locality, street, building)
        .then((result) => {
          prevResult = String(buildIcs(region, `${locality}, ${street} ${building}`, result))

          storeOutageMetadata({
            shutdown: !result.shutdown
              ? null
              : {
                updatedAt: formatDate(result.shutdown.updatedAt),
                startedAt: formatDate(result.shutdown.startedAt),
                endsAt: formatDate(result.shutdown.endsAt),
                reason: result.shutdown.reason,
              },
          })

          console.info(`[${new Date().toISOString()}] Collection completed`)

          return prevResult
        })
        .catch((error) => {
          console.error(`[${new Date().toISOString()}] Oops`, error)

          return prevResult ? prevResult : error.stack
        })
        .finally(() => {
          const responses = pendingResponses

          pendingResponses = []
          promise = undefined

          console.info(`Sending responses to ${responses.length} clients`)

          for (const { response, contentType, reqId } of responses) {
            console.info(`[${reqId}] Sending response at ${new Date().toISOString()}`)
            if (!response.headersSent) {
              response.set({
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
              })
              response.send(prevResult)
            }
          }
        })
    }

    console.info(`[${reqId}] Waiting for collection...`)
    await promise
    console.info(`[${reqId}] Done waiting at ${new Date().toISOString()}`)
  }

  app.get('/dtek-shutdowns.ics', async (request, response) => {
    await query(response, 'text/calendar; charset=utf-8')
  })

  storeOutageMetadata({ shutdown: null })
  app.listen(8084, '0.0.0.0')
}

main()
