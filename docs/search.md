# Search

Search examines the titles, descriptions, species, tags and environment of your
photos.

## Search box

The box accepts text, albums, people, known personalities and dates. Filters show
as chips that you can remove.

- Type at least 3 characters of a name. After 150 ms, suggestions show.
- A match can start anywhere in a word. For example, "man" finds "Rahman". Case
  and accents do not matter. Aliases also match.
- Each typed phrase shows at most 3 suggestions. Select "+N more" to see all.
- Text alone does not filter. Select a suggestion to add a filter.
- If two typed names match, "Add both" shows the number of photos.
- Press Enter to search.
- "Sort by" controls the order. The default is best match.

## People and known personalities

- You can select at most 5 in total. A photo must contain all of them.
- "Your people" are blue. Known personalities are violet and have a "known" mark.
- The two lists can contain the same real person.
- The Timeline page has the same filter in one list.

## Dates

- Use the date range control, or select Today, This week, This month or This year.
- "On this day" shows photos from the same month and day in all years.
- You can type dates: `lion june 2025`, `2025`, `jun 2025` or `2025-06-14`. The
  date becomes a filter and leaves the text.

Dates use UTC, not local time. In India, a photo from 00:00 to 05:29 shows on the
day before. Thus "Today" can omit early photos. See
[Architecture](architecture.md).

## AI Search

AI Search is a mode of the Search page. It needs a desktop Chrome with the Prompt
API (Gemini Nano).

### Turn on the Prompt API

1. Use a recent desktop Chrome.
2. In `chrome://flags`, turn on the Prompt API for Gemini Nano (for example
   `#prompt-api-for-gemini-nano`). Flag names can change.
3. Install the model from `chrome://on-device-internals`.

Without the API, "Ask AI" does not show.

### Use it

- Select "Ask AI" or press Cmd/Ctrl+Enter. The model changes your sentence into
  keywords.
- PixdeX searches for each keyword and ranks the photos. Rare keywords have more
  weight.
- Edit the keyword chips as necessary. Each result shows its matched keywords.
- "Add keywords" lets you type keywords without the model, for example
  `diya, rangoli`.
- "Search again" adds your typed keyword and searches again without the model.
- Enter in the main box does a normal search.
- Album, people, known and date chips apply to all keyword searches.
- "Hide people photos" uses subjects and tags, not face data. It does not show if
  a person filter is active.
- "Leave room for text" prefers photos with empty areas.

The URL keeps `mode=ai`, `q` (sentence), `kw` (keywords), `hidePeople=0` and
`room=0`. Old `/ai-search` links go to the Search page, and `people=0` becomes
`hidePeople=0`.

The model runs in the browser. Your sentence and images do not go to an AI
service. The browser sends only normal search and thumbnail requests to PixdeX.
For costs, see the [Development guide](development.md).
