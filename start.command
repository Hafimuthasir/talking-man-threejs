#!/bin/bash
cd "$(dirname "$0")"
PORT=8000
echo "Starting local server for Talking Man viewer on port $PORT..."
( sleep 1 && open "http://localhost:$PORT" ) &
python3 -m http.server "$PORT"
