import pytest
from fastapi.testclient import TestClient

from movie_robo.api import create_app
from movie_robo.service import MovieRoboService


@pytest.fixture
def client(settings) -> TestClient:
    return TestClient(create_app(settings, MovieRoboService(settings)))


def test_health(client: TestClient):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["persona"] == "Movie Robo"


def test_models_endpoint(client: TestClient):
    body = client.get("/v1/models").json()
    assert body["data"][0]["id"] == "test/model"


def test_skills_endpoint(client: TestClient):
    body = client.get("/v1/skills").json()
    assert "write_script" in body["data"]


def test_chat_completions(client: TestClient):
    resp = client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "Gumawa ka ng horror na kwento, 3 minuto, nakakakaba."}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["reference_genre"] == "horror"


def test_empty_messages_rejected(client: TestClient):
    resp = client.post("/v1/chat/completions", json={"messages": []})
    assert resp.status_code == 400


def test_ui_is_served(client: TestClient):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Movie Robo" in resp.text
