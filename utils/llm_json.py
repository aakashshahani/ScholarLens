"""
Tolerant parsing of JSON that a model was asked to return.

Every agent prompts for "ONLY valid JSON", and the model mostly complies — but
it occasionally wraps the payload in a ```json fence or adds a sentence of
preamble. A bare json.loads() then throws away an answer that was paid for.
This strips fences and, failing a direct parse, decodes the first JSON value
that starts at a '{' or '['.
"""

import json

_DECODER = json.JSONDecoder()


def parse_llm_json(text: str):
    """Parse the JSON value in a model response. Raises ValueError if none."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except ValueError:
        pass
    for i, ch in enumerate(raw):
        if ch in "[{":
            try:
                value, _ = _DECODER.raw_decode(raw, i)
                return value
            except ValueError:
                continue
    raise ValueError("No JSON value found in model output")
