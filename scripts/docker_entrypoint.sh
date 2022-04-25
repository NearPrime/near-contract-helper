#!/bin/sh

sleep 10
yarn migrate
yarn docker:start