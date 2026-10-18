from example_agent import parse_ports


def test_parse_ports():
    assert parse_ports('3030') == [3030]
    assert parse_ports('3031-3034') == [3031, 3032, 3033, 3034]
    assert parse_ports('3030,3035-3036') == [3030, 3035, 3036]
