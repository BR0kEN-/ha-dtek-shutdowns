#!/usr/bin/with-contenv bashio

node dtek-check-shutdown.js \
  "$(bashio::config region)" \
  "$(bashio::config locality)" \
  "$(bashio::config street)" \
  "$(bashio::config building)" \
  "$(bashio::config incapsula)"
