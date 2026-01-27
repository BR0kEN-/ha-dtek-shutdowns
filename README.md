# DTEK Outages Checker

## Why does this exist?

Yasno has proven to be unreliable. While they offer a convenient API, their schedule updates are not synchronized with DTEK, which is the actual source of truth as it is directly guided by NEC Ukrenergo.

Previously, I used [ha-yasno-outages](https://github.com/denysdovhan/ha-yasno-outages). However, besides Yasno’s data often being outdated, the component itself has a fixed 15-minute delay before fetching updates (though this may be improved with [this pull request](https://github.com/denysdovhan/ha-yasno-outages/pull/115)).

## How it works?

A Puppeteer-controlled browser visits the DTEK website, scrapes the outage schedule for a configured address, and publishes the data via MQTT. On the Home Assistant side, an automation listens to the MQTT topic and adds outage events to a calendar you set up.

The interval between the checks is configurable and can be set from 2 to 60 mins.

## Prerequisites

1. Go to [your HA calendars](https://my.home-assistant.io/redirect/calendar/) and make a new one, e.g. `DTEK Dnipro Outages 1.1`.

2. Now go to [automations](https://my.home-assistant.io/redirect/automations/) and hit `Create atuomation`.
   - Switch into the YAML mode.
   - Paste this:
     ```yaml
     alias: DTEK Power Outages Calendar
     mode: single
     variables:
       days: "{{ trigger.payload_json.schedule.days }}"
       group: "{{ trigger.payload_json.group }}"
     triggers:
       - trigger: mqtt
         options:
           topic: dtek/power/outages/schedule
           value_template: "{{ value_json.schedule is defined }}"
     actions:
       - alias: Loop over the days
         repeat:
           for_each: "{{ days }}"
           sequence:
             - variables:
                 day: "{{ repeat.item }}"
             - alias: Loop over outages for the day
               repeat:
                 for_each: "{{ day.intervals | selectattr('state', 'eq', 'outage') | list }}"
                 sequence:
                   - alias: Create an event in
                     action: calendar.create_event
                     data:
                       summary: Power outage (group {{ group }})
                       start_date_time: "{{ day.date }} {{ repeat.item.startsAt }}"
                       end_date_time: "{{ day.date }} {{ repeat.item.endsAt }}"
                     target:
                       entity_id: calendar.dtek_dnipro_outages_1_1
       - alias: Create a special shutdown event
         if:
           - condition: template
             value_template: "{{ shutdown is not none }}"
             alias: Has special shutdown event?
         then:
           - alias: Create an event in
             action: calendar.create_event
             data:
               summary: Power outage (group {{ group }})
               description: "{{ shutdown.reason }}"
               start_date_time: "{{ shutdown.startedAt }}"
               end_date_time: "{{ shutdown.endsAt }}"
             target:
               entity_id: calendar.dtek_dnipro_outages_1_1
     ```
   - Switch back to the visual editor:
     - hit `Loop over outages for the day`;
     - hit `Create an event in`;
     - select the calendar you have created before under the `Targets`.
     - locate the `Create a special shutdown event` block;
       - hit `Create an event in`;
       - select the calendar you have created before under the `Targets`.

3. Optionally make sensors for the next outage and power availability.

   Go to the [helpers](https://my.home-assistant.io/redirect/helpers/).

   - Hit `Create helper`, pick `Template` and then `Sensor`.
     - Name: `DTEK: Next Outage Start`
     - State: `{{ as_datetime(state_attr('calendar.dtek_dnipro_outages_1_1', 'start_time')) | as_local }}`
     - Device class: `Timestamp`
     - Hit `Submit`

   - Hit `Create helper`, pick `Template` and then `Sensor`.
     - Name: `DTEK: Next Power Available`
     - State: `{{ as_datetime(state_attr('calendar.dtek_dnipro_outages_1_1', 'end_time')) | as_local }}`
     - Device class: `Timestamp`
     - Hit `Submit`

## Installation

1. [![Install](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FBR0kEN-%2Fha-dtek-shutdowns)
2. Install & configure.
3. Turn on `Autoupdate` & `Watchdog`.
4. Start and check logs to ensure it's running.
