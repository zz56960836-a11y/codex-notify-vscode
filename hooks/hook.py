#!/usr/bin/env python3
# codex-notify hook (WSL). Copies minimal event metadata into a local spool that
# the VS Code extension reads. No network, no secrets, never blocks Codex.
import json
import os
import sys
import time
import uuid

SPOOL = "__SPOOL__"
PLATFORM = "__PLATFORM__"
MAX_PENDING = 500


def clip(value, limit=200):
    if isinstance(value, list):
        value = " ".join(str(v) for v in value)
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def build(raw):
    if not isinstance(raw, dict) or raw.get("agent_id"):
        return None
    event = raw.get("hook_event_name")
    tool = str(raw.get("tool_name") or "")
    tool_input = raw.get("tool_input") if isinstance(raw.get("tool_input"), dict) else {}
    summary = ""
    if event == "Stop":
        kind = "complete"
        summary = clip(raw.get("last_assistant_message"))
    elif event == "PreToolUse" and tool.rsplit(".", 1)[-1] in ("request_user_input", "request_user_input_async"):
        kind = "input"
        questions = tool_input.get("questions")
        if isinstance(questions, list) and questions and isinstance(questions[0], dict):
            summary = clip(questions[0].get("question") or questions[0].get("header"))
    elif event == "PermissionRequest":
        kind = "approval"
        summary = clip(tool_input.get("command") or tool_input.get("description") or tool)
    else:
        return None
    return {"v": 1, "kind": kind, "session": clip(raw.get("session_id"), 128),
            "turn": clip(raw.get("turn_id"), 128), "id": clip(raw.get("tool_use_id"), 128),
            "cwd": clip(raw.get("cwd"), 512), "summary": summary, "platform": PLATFORM,
            "ts": time.time()}


def main():
    try:
        data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        record = build(json.loads(data or b"{}"))
        if record is None:
            return
        # If the extension is gone (nobody consumes the spool), stop piling up files.
        if len(os.listdir(SPOOL)) >= MAX_PENDING:
            return
        name = "%d-%s.json" % (int(time.time() * 1000), uuid.uuid4().hex[:12])
        temporary = os.path.join(SPOOL, "." + name + ".tmp")
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
        os.replace(temporary, os.path.join(SPOOL, name))
    except Exception:
        pass


main()
sys.exit(0)
