from movie_robo.gate import gate_question, missing_fields


def test_missing_haba_and_mood():
    assert missing_fields("Gumawa ka ng horror na kwento") == ["haba", "mood"]


def test_only_mood_missing_when_duration_present():
    assert missing_fields("Gumawa ka ng horror na kwento, 3 minuto") == ["mood"]


def test_nothing_missing_when_complete():
    assert missing_fields("Gumawa ka ng horror na kwento, 3 minuto, nakakakaba") == []


def test_english_duration_units():
    assert missing_fields("Make a 30 second ad, funny") == []


def test_gate_question_priority_is_haba_first():
    q = gate_question("Gumawa ka ng horror na kwento")
    assert q is not None and "gaano katagal" in q


def test_gate_passes_when_complete():
    assert gate_question("Gumawa ka ng romance na kwento, 2 minuto, masaya") is None
