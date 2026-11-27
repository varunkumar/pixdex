# People

## Name faces

The People page (`/people`) shows named people and groups of similar unnamed
faces. The "People" card on a photo names or corrects its faces. "Show people on
photo" shows numbered boxes. Lists are in alphabetical order.

- Name a group, or add it to a person.
- PixdeX then searches for more faces of that person in the background. Keep the
  tab open until the progress card goes away.
- The index process also matches new faces to named people.
- A person page sorts photos by date, rating or name.
- The "Set as cover" icon on a photo selects a person's picture. The current cover
  has a blue "Cover" badge.
- If you remove the cover face, the default returns (the largest confirmed face).

## Matching

- A search after a name change examines unnamed faces. If you moved a face, it
  also examines the automatic matches of the first person.
- "Re-run matching" also examines all automatic matches. It takes more time.
- Matching never changes a confirmed face.
- Groups and matching ignore faces with a detection score below 0.7, or a side
  below 5% of the photo.
- Matching uses up to 30 confirmed faces for each person. It takes turns between
  photo years, largest faces first. Photos without a date count as one year. A
  scanned print uses its date, which is usually the scan date.
- This set changes when you name, confirm or remove a face. "Re-run matching" also
  updates it.

## Correct and review

- "Not X" rejects a match permanently.
- "Remove name" removes the name from a confirmed face.
- "Review suggestions" shows weak matches (score 0.4 to 0.5).
- "Confirm X" confirms one automatic match. It is in the menu of that photo on the
  person page.
- "Review auto matches" shows 48 faces, weakest first, all selected. Clear the
  wrong or unclear faces. Then select "Confirm N" or "Confirm N, mark M as Not X".
- Only faces on the screen change. A face that changed after the page loaded, or
  that has no picture, does not change.
- Only the person's owner can do this, for faces in their own albums.
- A wrong confirmed face can attract more wrong faces. Use "Not X" to correct it.

### To review

The People page shows "N matches to review". The list shows each person with a
count. "Next: <name>" goes to the next person with the most matches. Unnamed
groups are not counted. The count can be 5 minutes old.

Back returns to the same page and sort. A "← ..." link does the same, and its text
names the destination. Back also keeps review selections and open sections. A page
reload clears these.

## Ignore faces

The album owner can ignore faces, for example strangers.

- Use "Ignore group", the cross on a face, or "Ignore" on the photo's card.
- An ignored face is not grouped, matched or shown as a known personality. This
  applies to viewers too. A new scan keeps it ignored.
- To restore it, use "Ignored faces" on the People page or "Restore" on the photo.
- Small or unclear faces are behind "Other faces (N)" on the photo. You can name or
  ignore them there.
- A new photo of an ignored person shows as a new unnamed face.

## Owners and names

You manage the people that you created. Other people's names are private. You see
"Unnamed person" until you add your own name with "Add my name". Only you see that
name. To remove it, clear the text.

## Known personalities

The agent can suggest names of public figures from
[`agent/known/people.json`](../agent/known/people.json). A suggestion does not
identify, name or assign a face.

```bash
cd agent
npm run dev -- build-known-gallery        # make reference faces (slow)
npm run dev -- backfill-known --dry-run   # test the matches
npm run dev -- backfill-known             # save the matches
```

- If `agent/.index-state/known-gallery.json` exists, index runs use it
  automatically.
- On a new computer, run `known-gallery-pull` first.
- A new scan without this file removes known matches from those faces. Run
  `backfill-known` to restore them.
- `KNOWN_THRESHOLD` (0.6) and `KNOWN_MARGIN` (0.05) in
  `agent/src/known/matcher.ts` are first estimates. Use the dry run to adjust
  them. Then use `--rescore`.
- The gallery has a backup in your private R2 bucket. Only the agent can access it.

For list changes, the gallery, the manual face picker (`known-pick`) and all
options, see [agent/known](../agent/known/README.md). For the first rollout, see
the [Development guide](development.md).
