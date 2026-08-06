import requests
import pandas as pd


def fetch_obis_species_data(scientific_name: str, max_records: int = 100):
    url = "https://api.obis.org/v3/occurrence"
    params = {
        "scientificname": scientific_name,
        "size": max_records,
        "absence": "false",
    }
    response = requests.get(url, params=params, timeout=15)
    if response.status_code != 200:
        return None

    results = response.json().get("results", [])
    records = [
        {
            "scientificName": item.get("scientificName"),
            "latitude": item.get("decimalLatitude"),
            "longitude": item.get("decimalLongitude"),
            "depth_meters": item.get("depth"),
            "country": item.get("country", "International Waters"),
            "event_date": item.get("eventDate"),
        }
        for item in results
    ]

    df = pd.DataFrame(records).dropna(subset=["latitude", "longitude"])
    return df


def export_species_csv(scientific_name: str, out_path: str = "species_export.csv"):
    df = fetch_obis_species_data(scientific_name)
    if df is not None and not df.empty:
        df.to_csv(out_path, index=False)
        print(f"Exported {len(df)} records to {out_path}")
    else:
        print("No records found or request failed.")


if __name__ == "__main__":
    export_species_csv("Acropora cervicornis")