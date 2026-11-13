from direk.gate import QUESTIONS
from direk.service import DirekService


def test_gate_asks_for_haba_first(service: DirekService):
    result = service.chat([{"role": "user", "content": "Gumawa ka ng horror na kwento sa probinsya."}])
    assert result["gate"] == "haba"
    assert result["choices"][0]["message"]["content"] == QUESTIONS["haba"]
    assert result["reference_genre"] == "horror"


def test_gate_asks_for_mood_when_duration_present(service: DirekService):
    result = service.chat(
        [{"role": "user", "content": "Gumawa ka ng horror na kwento, 3 minuto."}]
    )
    assert result["gate"] == "mood"


def test_complete_prompt_generates_reply(service: DirekService):
    result = service.chat(
        [{"role": "user", "content": "Gumawa ka ng horror na kwento, 3 minuto, nakakakaba."}]
    )
    assert result["gate"] is None
    assert result["reference_genre"] == "horror"
    assert result["choices"][0]["message"]["content"]


def test_no_genre_skips_gate(service: DirekService):
    result = service.chat([{"role": "user", "content": "Kumusta ka, Direk?"}])
    assert result["gate"] is None
    assert result["reference_genre"] is None
    assert result["choices"][0]["message"]["content"]


def test_health_reports_backend_and_catalog(service: DirekService):
    health = service.health()
    assert health["ok"] is True
    assert health["backend"] == "echo"
    assert health["reference_available"] is True
    assert health["reference_rows"] > 0


def test_system_prompt_gets_references(service: DirekService):
    captured = {}

    class Spy:
        name = "spy"

        def generate(self, messages, *, temperature, top_p, max_tokens):
            captured["messages"] = messages
            return "ok"

    service._backend = Spy()
    service.chat(
        [{"role": "user", "content": "Gumawa ka ng horror na kwento, 3 minuto, nakakakaba."}]
    )
    system = captured["messages"][0]["content"]
    assert "REFERENSYA mula sa Netflix dataset" in system
    assert "horror" in system
