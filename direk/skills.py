"""Skill registry and the ```action``` block parser.

Local skills are executed by the model inside its own answer. API skills are
surfaced to the caller as a structured "action" object that an orchestrator
(the web UI, a workflow, a human) can run later.
"""

from __future__ import annotations

import json
import re

ACTION_RE = re.compile(r"```action\s*(.*?)```", re.S)

SKILLS: dict[str, dict] = {
    "write_script": {"kind": "local"},
    "shot_list": {"kind": "local"},
    "character_bible": {"kind": "local"},
    "ai_video_prompt": {"kind": "local"},
    "image_assets": {"kind": "api", "connector": "Cloudinary"},
    "media_edit": {"kind": "api", "connector": "Picsart Media Studio"},
    "poster_design": {"kind": "api", "connector": "Orshot"},
    "video_edit": {"kind": "api", "connector": "Descript"},
    "short_clips": {"kind": "api", "connector": "OpusClip"},
    "auto_producer": {"kind": "api", "connector": "AI Producer by OpusClip"},
    "motion_video": {"kind": "api", "connector": "HyperFrames by HeyGen"},
    "screen_demo": {"kind": "api", "connector": "Tella"},
    "growth_seo": {"kind": "api", "connector": "vidIQ"},
    "audience_research": {"kind": "api", "connector": "Tracy AI Interviewer"},
    "cloud_storage": {"kind": "api", "connector": "Google Drive"},
    "publish_post": {"kind": "api", "connector": "OpusClip/vidIQ/Tella", "confirm": True},
    "delete_asset": {"kind": "api", "connector": "Cloudinary/Drive", "confirm": True},
}


def extract_action(text: str) -> tuple[str, dict | None, str | None]:
    """Split a model reply into ``(clean_text, action, error)``.

    ``action`` is ``None`` for local skills (the model already did the work) and
    a descriptor dict for API skills.
    """
    match = ACTION_RE.search(text or "")
    if not match:
        return (text or "").strip(), None, None

    clean = text.replace(match.group(0), "").strip()
    try:
        payload = json.loads(match.group(1))
    except (ValueError, TypeError):
        return clean, None, "Sira ang format ng action."

    name = payload.get("skill")
    spec = SKILLS.get(name)
    if spec is None:
        return clean, None, f"Walang skill na '{name}'."
    if spec["kind"] == "local":
        return clean, None, None

    return (
        clean,
        {
            "skill": name,
            "connector": spec["connector"],
            "args": payload.get("args", {}),
            "needs_confirm": spec.get("confirm", False),
            "status": "needs_confirm" if spec.get("confirm") else "not_connected",
        },
        None,
    )
