// Reverse-engineered from https://www.dtek-dnem.com.ua/src/js/static/discon-schedule.js
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

  addEvent(summary, updatedAt, startsAt, endsAt, location, description) {
    if (description) {
      description += '\n '
    } else {
      description = ''
    }

    description += `Updated at ${formatDate(updatedAt)}`
    description += `\n Refreshed at ${this.refreshDate}`

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

  // @todo: What to do with this? It has a useful reason but creates a dup.
  // if (data.shutdown) {
  //   ics.addEvent(
  //     eventName,
  //     data.shutdown.updatedAt,
  //     data.shutdown.startedAt,
  //     data.shutdown.endsAt,
  //     location,
  //     data.shutdown.reason,
  //   )
  // }

  return ics
}

async function main() {
  const [,, region, locality, street, building] = process.argv
  const app = express()

  app.get('/dtek-shutdowns.ics', async (request, response) => {
    try {
      console.info(`[${new Date().toISOString()}] Collecting`)

      response.set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-cache',
      })

      response.send(
        String(
          buildIcs(
            region,
            `${locality}, ${street} ${building}`,
            await collect(region, locality, street, building),
          ),
        ),
      )

      console.info(`[${new Date().toISOString()}] Ok`)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Oops`, error)
      response.send(error.stack)
    }
  })

  app.listen(8086, '0.0.0.0')
}

main()
