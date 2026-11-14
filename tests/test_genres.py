from movie_robo.genres import find_genre


def test_tagalog_horror():
    assert find_genre("Gumawa ka ng horror na kwento sa probinsya") == "horror"


def test_tagalog_katatakutan():
    assert find_genre("Gusto ko ng katatakutan") == "horror"


def test_romance_maps_to_catalog_word():
    assert find_genre("Gusto ko ng romance na kwento") == "romantic"


def test_love_story_beats_shorter_keyword():
    assert find_genre("Isang love story sa Maynila") == "romantic"


def test_no_genre_returns_none():
    assert find_genre("Kumusta ka, Movie Robo?") is None


def test_empty_input_is_safe():
    assert find_genre("") is None
