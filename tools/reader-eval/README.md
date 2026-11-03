# Reader evaluation (offline)

Measures, on real labelled photos, how often the readers (fineness LED scale, weighbridge LCD, moisture) are right, how honest their confidence is, and - by cross-validation - whether learning from more photos really helps.
Nothing leaves your computer; the photos and labels are private and are **not** committed to GitHub (`data/` is git-ignored).

## Daily routine

1. Admin login > **Reader training** > **Download the training set (zip) and free the space**. The zip is checked for damage, then the app asks once more before it deletes exactly those photos from Supabase Storage.
2. Put the zip(s) next to this file (or anywhere) and import them:

   ```bash
   cd tools/reader-eval
   python3 -I import_data.py zip ~/Downloads/reader-training-*.zip
   ```

   Running it again adds to what is already there; the same photo is never counted twice.
3. Start a local server in the **project folder** and open the page:

   ```bash
   cd <project folder>
   python3 -m http.server 8766
   ```

   then open <http://localhost:8766/tools/reader-eval/index.html>
4. **1 - Measure the readers as they are now**: right/wrong per kind, how often a reading with 75 %+ confidence is wrong, and a table of "confidence vs how often it was really right".
   **2 - Does learning help?**: 5-fold cross-validation. Every photo is tested with examples learned only from the *other* photos. It tells you how many readings learning fixed and how many it broke.

## Other photo sets (e.g. weighment scale photos)

```bash
python3 -I import_data.py folder "../../weighment photos" "../../weighment photos/reader_results.csv" --kind weighment --value-col checked_value_kg
```

`--kind` is `weighment` (blue LCD indicator), `fineness_initial` / `fineness_final` (red LED scale) or `moisture`.

## What the page cannot do

* The moisture reader is a general text reader (Tesseract): it cannot learn from examples, so step 2 only covers the LED and LCD readers. Step 1 measures moisture too once you press *Include the moisture reader*.
* It needs at least 10 photos of a reader to run the cross-validation.
