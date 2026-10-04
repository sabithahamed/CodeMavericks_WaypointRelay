# Seed data (not included)

The Tech-Triathlon 2026 datasets may not be redistributed, so they are not in this repository.
Copy these files from the competition dataset folder into this directory before `docker compose up`:

| File | From the dataset folder | Required |
|---|---|---|
| `outlets.csv` | `General Data/` | yes |
| `vehicles.csv` | `General Data/` | yes |
| `district_travel.csv` | `General Data/` | yes |
| `service_allowance.csv` | `General Data/` | yes |
| `task2b_peak_day_scenarios.csv` | `Test Data/` | yes (the seeded delivery day, Scenario S1) |
| `task2b_peak_day_fleet.csv` | `Test Data/` | yes |
| `calendar.csv` | `General Data/` | optional, for the capacity outlook |
| `deliveries_train.csv` | `Training Data/` | optional, for the capacity outlook |
| `task1_test_inputs.csv` | `Test Data/` | optional, for the capacity outlook |

From a shell, with the dataset folder at `../Dataset/data`:

```bash
D="../Dataset/data"
cp "$D/General Data/"{outlets,vehicles,district_travel,service_allowance,calendar}.csv \
   "$D/Test Data/"{task2b_peak_day_scenarios,task2b_peak_day_fleet,task1_test_inputs}.csv \
   "$D/Training Data/deliveries_train.csv" seed/data/
```

The app reads these files once, on first start against an empty database. If a required file is missing, it stops and names the file.
