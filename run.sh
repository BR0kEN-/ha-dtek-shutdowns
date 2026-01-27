#!/usr/bin/with-contenv bashio

node dtek-check-shutdown.js \
  "$(bashio::config region)" \
  "$(bashio::config locality)" \
  "$(bashio::config street)" \
  "$(bashio::config building)" \
  "mqtt://$(bashio::config mqtt_username):$(bashio::config mqtt_password)@$(bashio::config mqtt_host):$(bashio::config mqtt_port)" \
  "$(bashio::config inverval)"
