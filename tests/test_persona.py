from movie_robo.movie_robo_persona import ASSISTANT_NAME, BRAND, MOVIE_ROBO_SYSTEM, OPERATOR


def test_persona_names_movie_robo():
    assert ASSISTANT_NAME == "Movie Robo"
    assert MOVIE_ROBO_SYSTEM.startswith("Ikaw si Movie Robo")


def test_persona_carries_the_brand():
    assert BRAND == "Moviecity"
    assert OPERATOR == "LJR Group"
    assert "Moviecity" in MOVIE_ROBO_SYSTEM
    assert "LJR Group" in MOVIE_ROBO_SYSTEM


def test_core_rules_survive_the_rebrand():
    # Filipino/Taglish, ask-for-details-first, and the real-person refusal.
    assert "Filipino/Taglish" in MOVIE_ROBO_SYSTEM
    assert "MAGTANONG LANG muna" in MOVIE_ROBO_SYSTEM
    assert "totoong tao" in MOVIE_ROBO_SYSTEM
