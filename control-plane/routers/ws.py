"""
WebSocket router — stream live log lines for a benchmark run.
"""
import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.omb_runner import runner

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/runs/{run_id}")
async def ws_run_logs(websocket: WebSocket, run_id: int):
    """
    Stream log lines for run_id to the connected WebSocket client.

    Polls runner.get_lines() every 100 ms, forwarding any new lines since
    the last check.  Sends a terminal JSON frame {"type": "done"} when the
    run finishes, then closes.
    """
    await websocket.accept()
    sent = 0
    try:
        # Wait up to 10 s for runner.start() to register the run.
        # For sweep runs the WS may connect before _execute_sweep calls
        # runner.start(), and is_done() returns True for unregistered IDs,
        # which would immediately close the socket with no logs.
        for _ in range(100):
            if runner.is_started(run_id):
                break
            await asyncio.sleep(0.1)

        while True:
            lines = runner.get_lines(run_id)

            # Forward any lines we haven't sent yet
            for line in lines[sent:]:
                await websocket.send_text(line)
            sent = len(lines)

            if runner.is_done(run_id):
                await websocket.send_text(json.dumps({"type": "done"}))
                break

            await asyncio.sleep(0.1)  # 100 ms poll
    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected for run %d", run_id)
