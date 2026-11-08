"""Saved observations and returned evidence remain complete Session facts."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness


EXPECTED_DIR = Path(__file__).parent / "expected"


@pytest.mark.parametrize("expected_file,event_type,event_key,notification_key", [
    ("artifact-observation-projection.json", "artifact/observations", "observationEvents", "observationNotifications"),
    ("branch-evidence-projection.json", "user/message", "branchResults", "branchResultNotifications"),
    ("artifact-export-projection.json", "artifact/export", "exportEvents", "exportNotifications"),
    ("artifact-question-projection.json", "user/message", "questionEvents", "questionNotifications"),
    ("program-state-question-projection.json", "user/message", "questionEvents", "questionNotifications"),
    ("program-error-question-projection.json", "user/message", "questionEvents", "questionNotifications"),
])
def test_saved_facts_retain_source_and_checkpoint(
    tmp_path: Path, expected_file: str, event_type: str, event_key: str, notification_key: str,
) -> None:
    expected = json.loads((EXPECTED_DIR / expected_file).read_text(encoding="utf-8"))
    script = tmp_path / "observation_runtime.py"
    script.write_text(
        """
import json
import os
import sys

def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    if message["method"] == "initialize":
        result = {"serverInfo": {"name": "observation-fixture"}}
    elif message["method"] == "session/query":
        session_id = message["params"]["sessionId"]
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "agent/inbox/spliced", "seq": 0, "time": 0,
            "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "accepted"}]}}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {
            "kind": "prompt", "messageId": "accepted"}}), flush=True)
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "turn/start", "seq": 1, "time": 0, "data": {"turn": 0}}})
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "assistant/message", "seq": 2, "time": 0, "data": {"message": {
                "role": "assistant", "content": [{"type": "text", "text": os.environ["MAIN_RESPONSE"]}]}}}})
        for event in json.loads(os.environ["SESSION_FACTS"]):
            notify("session.event", {"sessionId": session_id, "event": event})
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "turn/end", "seq": 4, "time": 0,
            "data": {"turn": 0, "reason": {"kind": "completed"}}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
        continue
    elif message["method"] == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method")
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
""".strip(), encoding="utf-8",
    )
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"MAIN_RESPONSE": expected["finalResponse"],
             "SESSION_FACTS": json.dumps(expected[event_key])},
    ) as harness:
        result = harness.run([{"type": "text", "text": "Continue explaining"}], session_id="sdk-observation")
    notifications = [notification for notification in result.notifications
                     if notification.method == "session.event"
                     and notification.payload["event"]["type"] == event_type]
    assert all(notification.payload["sessionId"] == result.session_id for notification in notifications)
    assert {
        "finalResponse": result.final_response,
        event_key: [event for event in result.events if event["type"] == event_type],
        notification_key: [{"method": notification.method, "event": notification.payload["event"]}
                           for notification in notifications],
        "assistantTexts": [block["text"] for event in result.events if event["type"] == "assistant/message"
                           for block in event["data"]["message"]["content"] if block["type"] == "text"],
    } == expected
