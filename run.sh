#!/usr/bin/env bash
# Build and run the Grocery Store Billing System (Git Bash / Linux / macOS).
# Pass --demo to run the headless self-test instead of the web server.
set -e
cd "$(dirname "$0")"
mkdir -p bin
find src -name "*.java" > sources.txt
javac -cp "lib/*" -d bin @sources.txt
rm -f sources.txt
java -cp "bin:lib/*" grocery.Main "$@"
