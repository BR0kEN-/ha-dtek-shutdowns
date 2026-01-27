# DTEK Outages Checker

## Why does this exist?

Yasno has proven to be unreliable. While they offer a convenient API, their schedule updates are not synchronized with DTEK, which is the actual source of truth as it is directly guided by NEC Ukrenergo.

Previously, I used [ha-yasno-outages](https://github.com/denysdovhan/ha-yasno-outages). However, besides Yasno’s data often being outdated, the component itself has a fixed 15-minute delay before fetching updates (though this may be improved with [this pull request](https://github.com/denysdovhan/ha-yasno-outages/pull/115)).

## How it works?

A Puppeteer-controlled browser visits the DTEK website when the API endpoint is accessed, scrapes the outage schedule for a configured address, and returns an `*.ics` calendar. This calendar is then imported into Home Assistant via the [Remote calendar](https://www.home-assistant.io/integrations/remote_calendar/) integration. No history is preserved—once the schedule changes or the current day ends, the events disappear.

## Install

1. [![Install](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FBR0kEN-%2Fha-dtek-shutdowns)
2. Install & configure the address to monitor.
3. Turn on `Autoupdate` & `Watchdog`.
4. Start and check logs to ensure it's running.

## Configure

1. Add the [Remote Calendar](https://my.home-assistant.io/redirect/config_flow_start?domain=remote_calendar) integration:

   1. Name it, i.e. `DTEK Dnipro Outages 1.1`.

   2. Set the calendar URL to `http://<YOUR_HA_URL>:8086/dtek-shutdowns.ics`.

2. Configure custom polling interval:
   1. Disable default polling:
      - Go to [devices & services](https://my.home-assistant.io/redirect/integrations);
      - hit `Remote Calendar`;
      - find created calendar and open its contextual menu (three-dots button on the right);
      - hit `System options`;
      - toggle off `Enable polling for changes`;
      - hit `Update`.

   2. Create the automation with the interval you like:
      ```yaml
      mode: single
      alias: DTEK Outages Calendar Update
      description: ""
      triggers:
        - trigger: time_pattern
          minutes: /3
      conditions: []
      actions:
        - action: homeassistant.update_entity
          metadata: {}
          data:
            entity_id:
              - calendar.dtek_dnipro_outages_1_1
      ```

      Remember to update the calendar's entity ID and the update interval.

3. Optionally make sensors for the next outage and power availability.

   Go to the [helpers](https://my.home-assistant.io/redirect/helpers/):

   1. Hit `Create helper`, pick `Template` and then `Sensor`.
      - Name: `DTEK: Next Outage Start`
      - State: `{{ as_datetime(state_attr('calendar.dtek_dnipro_outages_1_1', 'start_time')) | as_local }}`
      - Device class: `Timestamp`
      - Hit `Submit`

   2. Hit `Create helper`, pick `Template` and then `Sensor`.
      - Name: `DTEK: Next Power Available`
      - State: `{{ as_datetime(state_attr('calendar.dtek_dnipro_outages_1_1', 'end_time')) | as_local }}`
      - Device class: `Timestamp`
      - Hit `Submit`

   Remember to update the calendar's entity ID.

## Update

After updating the addon, the calendar has to be reloaded manually:

- Go to [devices & services](https://my.home-assistant.io/redirect/integrations);
- hit `Remote Calendar`;
- find created calendar and open its contextual menu (three-dots button on the right);
- hit `Reload` and wait until it finishes.

> [!TIP]
> The autoupdate may cause disruption, so whenever you see no events while they're anticipated, do this cross-check:
> - try reloading the integration;
> - check the addon's logs - anything suspicious? report if it doesn't resolve on its own after a couple of retries.
