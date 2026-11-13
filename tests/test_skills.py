from direk.skills import SKILLS, extract_action


def test_plain_text_passes_through():
    clean, action, error = extract_action("Sige, simulan natin.")
    assert clean == "Sige, simulan natin."
    assert action is None and error is None


def test_local_skill_is_stripped_and_not_returned_as_action():
    text = 'Narito ang script.\n```action\n{"skill": "write_script"}\n```'
    clean, action, error = extract_action(text)
    assert clean == "Narito ang script."
    assert action is None and error is None


def test_api_skill_becomes_action_descriptor():
    text = 'Gagawa ako ng poster.\n```action\n{"skill": "poster_design", "args": {"size": "1080x1350"}}\n```'
    clean, action, error = extract_action(text)
    assert action == {
        "skill": "poster_design",
        "connector": "Orshot",
        "args": {"size": "1080x1350"},
        "needs_confirm": False,
        "status": "not_connected",
    }
    assert error is None and "```action" not in clean


def test_confirm_skill_requires_confirmation():
    _, action, _ = extract_action('```action\n{"skill": "publish_post"}\n```')
    assert action["needs_confirm"] is True
    assert action["status"] == "needs_confirm"


def test_unknown_skill_reports_error():
    _clean, action, error = extract_action('text\n```action\n{"skill": "hack_nasa"}\n```')
    assert action is None
    assert error and "hack_nasa" in error


def test_broken_json_reports_error():
    _, action, error = extract_action("text\n```action\n{not json}\n```")
    assert action is None and error == "Sira ang format ng action."


def test_registry_has_both_kinds():
    kinds = {spec["kind"] for spec in SKILLS.values()}
    assert kinds == {"local", "api"}
