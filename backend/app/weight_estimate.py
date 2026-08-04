def estimate_weight_grams(length_cm: float, a: float, b: float) -> float:
    """Standard allometric length-weight relationship, W = a * L^b
    (Le Cren 1951), the formula fisheries science actually uses to
    convert a measured length into an estimated weight. a/b are
    species-specific published coefficients — not guessed — the
    researcher supplies them (typically from FishBase) since automating
    that lookup isn't something we're wiring up without verifying it
    against a live, working endpoint first.
    """
    return round(a * (length_cm ** b), 1)


def fishbase_search_url(scientific_name: str) -> str:
    return f"https://www.fishbase.se/search.php?q={scientific_name.replace(' ', '+')}"