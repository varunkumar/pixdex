# Index photos

The agent in `agent/` indexes photos on your computer. The web interface does not
index photos.

## Set up

1. Install [Ollama](https://ollama.com).
2. Pull the model: `ollama pull qwen3.8:27b-mlx`.
3. Copy `agent/.env.example` to `agent/.env`.
4. Set `OLLAMA_MODEL=qwen3.8:27b-mlx`.
5. Set `CLOUDFLARE_API_BASE_URL`.
6. Set `INGEST_TOKEN` to the value of the Worker secret.
7. Set `OWNER_EMAIL` to your Google sign-in email.

## Commands

Run these commands in `agent/`:

```bash
npm run dev -- index-local "/path/to/folder"    # one local folder
npm run dev -- index-drive                      # select a Google Drive folder (read-only)
npm run dev -- index-drive --folder <id-or-url> # no prompts, can be repeated
npm run dev -- index-batch /Volumes/T9/Photos   # many albums, can resume
npm run dev -- index-status [--json]            # progress, time left and errors
```

## Process

For each photo, the agent:

1. Calculates a hash. It skips a photo that is already in the index.
2. Reads the EXIF data (camera, lens, exposure, GPS) and makes an upright
   thumbnail.
3. Asks the vision model for subjects, colors, patterns, tags, season,
   environment and watermark. Then it asks for a score (1 to 10) and a short
   title, and then a caption and hashtags.
4. Finds faces and species, if the sidecars are on.
5. Sends the metadata, thumbnail and face crops to the Worker.

## Places from GPS

PixdeX can give the name of the nearest town (50 km at most) to each photo that has a GPS position. It uses a list on
your computer. No position goes to an outside service. The list is
[GeoNames](https://www.geonames.org/) `cities500`, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

1. Download the list one time. Run these commands in `agent/`:

   ```bash
   mkdir -p .index-state/geonames
   curl -fL https://download.geonames.org/export/dump/cities500.zip -o .index-state/geonames/cities500.zip
   unzip -o .index-state/geonames/cities500.zip -d .index-state/geonames
   ```

2. Add places to the photos that are already indexed:

   ```bash
   npm run dev -- backfill-places --dry-run   # count only
   npm run dev -- backfill-places
   ```

- When the list is there, indexing also adds the place to new photos. Restart an indexing run that is in progress.
- Set `GEONAMES_FILE` to keep the list in a different location.
- A forest or park shows the name of the nearest town.

## Models

| Task | Model | Notes |
|---|---|---|
| Description and score | `qwen3.8:27b-mlx` | Runs in Ollama (`OLLAMA_BASE_URL`, default `http://localhost:11434`). |
| Faces (optional) | InsightFace `buffalo_l` | CoreML or CPU. For personal, non-commercial use only. |
| Species (optional) | BioCLIP 2.5 Huge (fp16) and OWLv2 | Local sidecar. |

If you do not set `OLLAMA_MODEL`, the agent uses `qwen3.5:27b-mlx`. Each photo
records its model. A model change does not index old photos again, so a library
can have more than one model.

## Google Drive

### Which files

The agent applies these rules to each folder:

- If a folder has a `Processed` subfolder (any case), the agent uses only that
  subfolder.
- If not, it uses the folder's photos and examines all subfolders.
- It ignores camera RAW files (for example CR2, NEF, ARW, DNG, RAF, ORF, RW2).
- It ignores application folders: `*.lrdata`, `*.aep`,
  `Adobe After Effects Auto-Save`, `(Footage)`, `*_AME`, `allresources` and
  `*.collagefactoryfree`.
- It skips duplicate content.
- It includes shared drives and "shared with me" folders.

To ignore more folders, use `--exclude <name-or-glob>`, for example
`--exclude video --exclude "*backup"`. It matches the full folder name, in any
case. `*` is a wildcard. It never skips a `Processed` folder.

### Album names

The album is the first folder below the folder that you select. For example,
`Arun Marriage / Marriage Photos / 001` is the album "Arun Marriage". Photos
directly in the selected folder use its name. `index-local` uses the folder that
contains the photo.

The folder search shows each parent folder and ID. You can also give the folder
URL with `--folder`.

### Dry run

`index-drive --dry-run` shows a folder tree. It shows photo counts, sizes, indexed
photos, large files and ignored items. It does not download files or use the
models. It only asks the Worker which photos are indexed.

### Speed, disk and errors

- The agent lists six folders at a time. It starts to index while it lists.
- It reports a folder that it cannot list, and continues.
- It skips indexed photos without a download, by their SHA-256.
- It tries temporary Drive errors again.
- With `--folder`, the exit code is 1 if a photo failed.
- Downloads go to `<tmpdir>/pixdex-drive-staging`. At most two photos are there at
  one time. The agent deletes each after use.
- `DRIVE_STAGING_MAX_MB` (default 1024) is the largest file size.
- A new run deletes files that are older than one hour.
- If Google rejects your login, the agent deletes `agent/.google-token.json`. Run
  the command again to sign in. In "testing" mode, a login expires after 7 days.

## Batch indexing

`index-batch` indexes each `<album>/Processed` folder, one album at a time. It
skips `Unprocessed`. It saves progress in `agent/.index-state/queue.json`.

- You can stop it and start it again. It does not do finished albums again.
- You can give album folders and folders of albums together.
- A new run finds new albums. It queues a finished album again if the photo count
  changed.
- `--priority=<regex,...>` indexes matching albums first. The default puts
  wildlife albums first.
- `--retry-failed` tries albums with failed photos again.
- If Ollama, the Worker or a disk is not available, it waits.
- To start it at login (macOS), run `agent/scripts/install-launchd.sh <folders...>`.
  To remove it, use `--uninstall`.
- The log file is `agent/.index-state/batch.log`.

## Move an album

```bash
cd agent
npm run move-album -- /Volumes/T9/abc /Volumes/T9/xyz --dry-run     # preview
npm run move-album -- /Volumes/T9/abc /Volumes/T9/xyz               # move and update
npm run move-album -- /Volumes/T9/abc /Volumes/T9/xyz --index-only  # already moved
```

- The script moves the folder and updates the photo paths in the index.
- Between volumes, it copies the files, checks their sizes, then deletes the
  source.
- Captions, edits and faces stay. The album name does not change.
- The destination must not exist.
- If the update fails after the move, use `--index-only`.

## Face sidecar (optional)

1. Obey the setup in [agent/sidecar](../agent/sidecar/README.md).
2. Start it: `python3 agent/sidecar/server.py`.
3. Set `FACE_SIDECAR_URL=http://127.0.0.1:8799` in `agent/.env`. The address must
   be loopback.

A sidecar error does not stop the photo. Only the face crop goes to the cloud.

## Species sidecar (optional)

The vision model is not good at bird names. The species sidecar examines the full
photo and each bird in it.

1. Start `species_server.py` (see [agent/sidecar](../agent/sidecar/README.md)).
2. Set `SPECIES_SIDECAR_URL` in `agent/.env`.

- Results are limited to species of the photo's region. The region comes from GPS
  or the album name (`agent/species/regions.json`).
- It drops results below 0.5 confidence. A full-photo result below 0.9 also needs
  an animal in the model's subjects.
- Search ranks species above the model's words. Your own edits have priority.
- A sidecar error does not stop the photo.
- Photos stay on your computer. Only region names go to GBIF.

To add species to indexed photos:

```bash
cd agent
npm run dev -- build-species-regions                  # first time, and after region changes
npm run dev -- backfill-species --list                # photos that need a scan
npm run dev -- backfill-species --dry-run --limit 20  # test, writes nothing
npm run dev -- backfill-species --album "Bandipur (29,31-Mar-2025)" --limit 200
npm run dev -- backfill-species                       # all, safe to stop and start again
```

A scanned photo is not scanned again. A photo with a missing file stays in the
queue. Google Drive photos need a stored login from `index-drive`.
