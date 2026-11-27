# Person Faces Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Faces" tab to the person page that shows a grid of this person's faces.

**Architecture:** A new presentational component, `FaceGrid`, draws square face tiles with the existing photo tile classes. `PersonPage` adds Mantine tabs and passes its current `PersonFaceActions`, `AutoMark` and `CoverBadge` to the grid. The data comes from the current `GET /people/:id/faces?photos=` request.

**Tech Stack:** React 19, Mantine, TanStack Query, react-router, Vitest with Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-27-person-faces-view-design.md`

## Global Constraints

- No new Worker route, query or migration. No change in `worker/` or `functions/`.
- Tab labels: "Photos" and "Faces (N)", where N is `person.faceCount`. The address holds `tab=faces`. No `tab` means Photos.
- Exact copy: "Loading faces", "Could not load faces", "Try again", "No faces on this page."
- Hide controls that a user cannot use. Do not disable them.
- Show confirmed and auto faces only. Owner controls and the sparkle need `person.canEdit`. "Confirm X" also needs `photo.canEdit`.
- Controls are at least 24px by 24px.
- Write all text in ASD-STE100. Do not use em dashes.
- Work on branch `feat/person-faces-tab`. Do not push. Do not bypass the pre-commit hook.
- End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A face without `cropUrl`, or with a box as wide as the photo: it shows a thumbnail cut with finite CSS values (Task 1).
- Two faces of the person in one photo: two tiles, left to right, with different accessible names (Task 1).
- A page change on the Faces tab: no faces of the old page under the new page, only the loading state (Task 2).
- "Not X" on a face: the other tiles stay while the data loads again (Task 2).
- `tab=faces` for an unknown person or a person with no photos: the page does not load forever (Task 2).

---

### Task 1: FaceGrid component

**Files:**
- Create: `src/components/FaceGrid.tsx`
- Modify: `src/index.css` (after the `.pdx-masonry` block)
- Test: `src/components/__tests__/FaceGrid.test.tsx`

**Interfaces:**
- Consumes: `SerializedFace`, `SerializedPhoto`, `makePhoto`, `renderWithProviders`.
- Produces:

```ts
export interface FaceItem { face: SerializedFace; photo: SerializedPhoto; label: string }
/** This person's confirmed and auto faces, in photo order, then left to right. */
export function faceItems(faces: SerializedFace[], photos: SerializedPhoto[], personId: string): FaceItem[];
// default export
FaceGrid(props: {
  items: FaceItem[];
  badges?: (item: FaceItem) => ReactNode;
  mark?: (item: FaceItem) => ReactNode;
  actions?: (item: FaceItem) => ReactNode;
})
```

`label` is `photoCaption(photo)`. If a photo has two or more items, it is `<caption>, face <n>`, with n from 1.

- [ ] **Step 1: Create the branch**

Run: `git switch -c feat/person-faces-tab`, then commit the spec and this plan (`docs: spec and plan for the person faces tab`).

- [ ] **Step 2: Write the failing tests**

Mock `thumbnailUrl` as `FaceTile.test.tsx` does. Build faces with `personId: 'pe1'`, `status: 'confirmed'`.

```tsx
it('keeps confirmed and auto faces of the person, in photo order then left to right', () => {
  const items = faceItems(
    [face('b', 'p2'), face('right', 'p1', { bbox: box(0.6) }), face('left', 'p1', { bbox: box(0.1) }),
     face('other', 'p1', { personId: 'pe2' }), face('open', 'p1', { status: 'unassigned' }), face('gone', 'p9')],
    [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })], 'pe1');
  expect(items.map((i) => i.face.id)).toEqual(['left', 'right', 'b']);
});

it('gives two faces of one photo different names', () => {
  // two faces on p1, one on p2
  expect(items[0].label).toMatch(/, face 1$/);
  expect(items[1].label).toMatch(/, face 2$/);
  expect(items[2].label).not.toMatch(/face \d/);
});

it('shows the crop as a lazy picture in a link to the photo', () => {
  // face with cropUrl '/faces/f1/crop'
  const link = screen.getByRole('link', { name: /leopard/i });
  expect(link).toHaveAttribute('href', '/photos/p1');
  expect(link.querySelector('img')).toHaveAttribute('src', '/api/faces/f1/crop');
  expect(link.querySelector('img')).toHaveAttribute('loading', 'lazy');
});

it('cuts a face without a crop out of the thumbnail', () => {
  // bbox { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }
  const cut = screen.getByTestId('face-cut');
  expect(cut.style.backgroundImage).toContain('/api/thumbnails/h1');
  expect(cut.style.backgroundSize).toBe('200% 250%');
  expect(cut.style.backgroundPosition).toBe('20% 33.333%');
});

it('stays finite for a box as large as the photo', () => {
  // bbox { x: 0, y: 0, w: 1, h: 1 }
  expect(screen.getByTestId('face-cut').style.backgroundPosition).toBe('0% 0%');
});

it('puts badges, mark and actions in the photo tile places', () => {
  // render props return <span>badge</span>, <span>mark</span>, <button>act</button>
  expect(screen.getByText('badge').closest('.pdx-tile-badges')).not.toBeNull();
  expect(screen.getByText('mark').closest('.pdx-tile-line')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'act' }).closest('.pdx-tile-actions')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'act' }).closest('a')).toBeNull();
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/components/__tests__/FaceGrid.test.tsx`
Expected: FAIL, `../FaceGrid` does not exist.

- [ ] **Step 4: Implement `faceItems` and `FaceGrid`**

- Follow the DOM structure of `PhotoTile.tsx`: `pdx-tile-item`, `pdx-tile` (aspect ratio 1), `pdx-tile-link`, `pdx-tile-overlay` (title and date only), `pdx-tile-badges`, `pdx-tile-actions`, `pdx-tile-cap` (sparkle if `mark`, caption, date).
- The link name is `<label>, <date>`, or `<label>` with no date.
- A crop is an `img` with class `pdx-tile-img`. The `img` has `alt={label}`.
- A cut is a `div` with `data-testid="face-cut"` that fills the tile. Size is `100/w % 100/h %`. Position is `x/(1-w)*100 %` per axis, or 0 if the divisor is not positive. Round to 3 decimals.
- Do not change `FaceTile.tsx`.

CSS:

```css
/* Face grid (person page, Faces tab): equal squares that fill the width. Three across on a phone. */
.pdx-faces { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 6px; }
@media (min-width: 36em) { .pdx-faces { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); } }
@media (min-width: 62em) { .pdx-faces { gap: 8px; } }
```

Add `min-width: 0` to the grid items, so a long caption does not widen a column.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/components/__tests__/FaceGrid.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit** (`feat: face grid with photo tile controls`)

---

### Task 2: Tabs on the person page

**Files:**
- Modify: `src/components/PersonPage.tsx`
- Test: `src/components/__tests__/PersonPage.test.tsx`

**Interfaces:**
- Consumes: `FaceGrid`, `faceItems`, `FaceItem` from Task 1. `PersonFaceActions`, `AutoMark`, `CoverBadge` as they are.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

Add `const showFaces = () => renderWithProviders(<PersonPage />, { route: '/people/pe1?tab=faces', path: '/people/:id' });`.

```tsx
it('opens Photos first and moves to Faces from its tab', async () => {
  vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('f1')]);
  show();
  expect(await screen.findByRole('tab', { name: 'Photos' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Faces (3)' }));
  expect(await screen.findByTestId('face-cut')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: /columns/i })).not.toBeInTheDocument();
});
```

Before you write the last assertion, read `ColumnsToggle.tsx` and query its real role and name. Assert that it is present on Photos and absent on Faces.

Add one test for each line. Use the mock data in the file.

| Test name | Assertions |
|---|---|
| `keeps the page and sort when the tab changes` | Start at `?page=2&sort=rating` with `total: 48`. After the Faces click, the last `searchPage` call has `offset: 24`, `sort: 'rating'`. |
| `sets a face as cover and confirms or rejects it from its tile` | One auto face `f1`. "Set as cover: ..." calls `setPersonCover('pe1', 'f1')`. "Photo actions" then "Not Asha" calls `rejectFace('f1', 'pe1')`. A second render: "Confirm Asha" calls `reviewAutoFaces('pe1', { confirm: ['f1'], reject: [] })`. |
| `acts on the face of the tile, not the largest face` | Two faces on `p1`. The button named `...face 2` calls `setPersonCover` with the id of the right face. |
| `marks the cover face only` | `person.cover.id === 'f1'`, faces `f1`, `f2` on `p1`. One "Cover" badge. One "Set as cover" button. |
| `shows a viewer the faces with no controls or sparkle` | `canEdit: false`. `getPersonFaces` is called with `('pe1', ['p1'])`. No button "Set as cover", no "Matched automatically". |
| `does not ask for faces for a viewer on Photos` | The current test already covers this. Keep it unchanged. |
| `shows loading, not the old faces, while the next page loads` | Page 2 `getPersonFaces` never resolves. After "Page 2", progressbar "Loading faces" shows and no `face-cut` exists. |
| `keeps the other faces while they load again after Not X` | After the reject, the next `getPersonFaces` never resolves. The other tile stays. No "Loading faces". |
| `offers Try again when the faces fail on the Faces tab` | Rejected request: "Could not load faces". "Try again" calls `getPersonFaces` again. |
| `says when the page has no faces` | Empty answer: "No faces on this page." |
| `does not load forever for an unknown person` | `getPeople` returns `[]`. "This person was not found." shows. No progressbar "Loading faces". |
| `hides the tabs for a person with no photos` | `photoCount: 0`, empty search. No `tab` role. "No photos for this person yet." |

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/components/__tests__/PersonPage.test.tsx`
Expected: the new tests FAIL. The old tests PASS.

- [ ] **Step 3: Implement the tabs in `PersonPage.tsx`**

- Take `isPending` from the `['people']` query as `peoplePending`.
- `tab` is `'faces'` if `params.get('tab') === 'faces'` and (`person ? person.photoCount > 0 : peoplePending`). Else it is `'photos'`.
- The faces query is enabled if `photoIds.length > 0` and `person` exists and (`person.canEdit` or `tab === 'faces'`).
- Use `Tabs` with `keepMounted={false}`, as in `AlbumPhotos.tsx`. A change calls `update({ tab: v === 'faces' ? 'faces' : null })`.
- Render `Tabs.List` only if `person && person.photoCount > 0`.
- Keep the page error, photo loading, "no photos", sort row and `ListPagination` outside the panels. Render `ColumnsToggle` only on Photos.
- Move the "Could not load photo actions" row and `PhotoGrid` into the Photos panel.
- Faces panel, in this order:
  - if `faces.isError`: the error row;
  - if there are photos and no items: "Loading faces" while `faces.isPending || faces.isPlaceholderData`, else "No faces on this page." (not on error);
  - else `FaceGrid`.
- Grid props, for owners only: `badges` shows `CoverBadge` if `item.face.id === person.cover?.id`. `mark` shows `AutoMark` for status `auto`. `actions` is `PersonFaceActions` with `auto` = the face if auto, `candidate` = the face, `isCover` as for the badge, `label={item.label}`, `canConfirm={item.photo.canEdit}`.
- Update the doc comment on `PersonFaceActions` ("Per photo or face").

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 5: Run `graphify update .` and commit** (`feat: faces tab on the person page`)

---

### Task 3: Verify, measure and document

**Files:**
- Modify: `docs/people.md`, `docs/agents/people.md`, `docs/agents/frontend.md`
- Modify only if the browser check needs it: `dev/mockApi.ts`

**Interfaces:**
- Consumes: the finished tab.
- Produces: nothing.

- [ ] **Step 1: Check in a browser**

Run: `PIXDEX_MOCK=1 npm run dev`. Open a person with `?tab=faces`.
Expected, at widths 360 px and 1280 px, in light and dark:
- three or more faces across, no horizontal scroll;
- hover controls on a mouse, caption line and visible controls with touch emulation;
- the controls do not overlap the Cover badge on a 100 px tile (if they do, fix the CSS);
- Back from a photo returns to the Faces tab and page.

- [ ] **Step 2: Measure the viewer D1 cost**

Write a temporary test in `worker/test/` that runs `personPhotoFacesSql` with a viewer scope on 48 photos with 3 faces each. Read `meta.rows_read` and `meta.rows_written`. Take the setup from `worker/test/person-faces.test.ts`.
Run: `cd worker && npx vitest run test/<temporary file>`
Expected: 0 rows written, a rows-read number. Delete the temporary file.

If the number is more than 2 times 336, tell the user before you continue.

- [ ] **Step 3: Update the docs**

- `docs/people.md`: the Faces tab, shared pages, owner actions, viewers.
- `docs/agents/people.md`, "Person page faces": a viewer now sends the request, only on the Faces tab. Record the measured numbers.
- `docs/agents/frontend.md`: `FaceGrid`, `tab=faces`, no columns control on Faces.

- [ ] **Step 4: Run all checks**

Run: `npm test && npm run lint && npm run build && (cd worker && npm test && npm run typecheck)`
Expected: all pass.

- [ ] **Step 5: Commit** (`docs: faces tab`)
