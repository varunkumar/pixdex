# Faces tab on the person page

## Intent

A person page shows full photos. Add a view that shows only the faces, for pleasant browsing.
The view must agree with the existing design.

## Goals

- Show a grid of this person's faces on `/people/:id`.
- Use tabs like the album page.

## Non-goals

- No new Worker route, query or migration.
- No separate page numbers for faces.
- No change to the people list, "Suggestions" or "Review auto matches".

## Approaches

- **A (selected):** show the faces of the current page of photos. It costs almost nothing. A page has about 48 faces at most.
- **B:** a face list with its own pages. It can show more faces, but it needs a new route and adds D1 reads.

## Design

### Tabs

- Use Mantine `Tabs`, as `AlbumPhotos.tsx` does: "Photos" and "Faces (N)". N is `person.faceCount`.
- The address holds `tab=faces`. No `tab` means Photos.
- Show the tab list when the person has photos. Mount only the active panel.
- The sort icons and page controls apply to both tabs. A tab change keeps the page.
- Hide the columns control on the Faces tab.

### Grid

- Small square tiles like "Review auto matches": 96 px, medium radius and spacing. A phone shows 3 across, 8 px apart.
  (Changed during the build, at the owner's request. The first design used larger tiles that filled the width.)
- Faces follow the photo order. Two faces in one photo show as two tiles, left to right.
- A tile opens the photo. Its accessible name includes the photo caption.
- Show confirmed and auto faces only.
- Use the face crop. A face without a crop uses the cut from the thumbnail. Load images lazily.

### Tile controls

These agree with photo tiles:

- Hover shows the photo title and date.
- A touch screen shows the date under the face (the caption if there is no date) and keeps the controls visible.
- An auto match has the sparkle mark.
- The person's creator gets one "Face actions" menu: "Set as cover" and, for an auto face, "Confirm X" and "Not X".
  Each acts on that face. (Changed after the web guide review: two 44 px touch targets do not fit on a small tile.)
- "Confirm X" needs `canEdit` on the photo.
- The cover face has `CoverBadge`.

### Shared viewers

- Viewers see the Faces tab without owner controls and without the sparkle mark.
- The page requests faces for a viewer only when the Faces tab is open.

### States

- Loading: `PageLoading` with the label "Loading faces". Do this also while faces for a new page load.
- Error: "Could not load faces" with "Try again".
- No faces on the page: "No faces on this page."

## Performance

- Worker CPU: no new code. The existing route maps the faces of at most 48 photos.
- D1, owner: no change.
- D1, viewer: one more request for each page on the Faces tab. The measured owner case is about 336 rows read
  and 0 written (48 photos, 3 faces each). A viewer also pays the album scope check and name label lookups.
  These are not measured. Measure them with a local D1.

## Constraints

- Face crops are 192 px. Do not show tiles much larger than that.
- Person names stay private. The existing route does this.

## Documentation and tests

- Update `docs/people.md`, `docs/agents/people.md` and `docs/agents/frontend.md`.
- Add frontend tests for the tabs, the grid, owner and viewer controls, and the states.
- Add dummy data to `dev/mockApi.ts` if the view needs it.

## Left to the builder

Component structure, CSS and how `FaceTile` becomes fluid.
