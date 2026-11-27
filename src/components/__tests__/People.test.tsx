import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workerApiClient } from "../../services/api/WorkerApiClient";
import {
  leaveAndGoBack,
  renderWithProviders,
  renderWithRouter,
} from "../../test/renderWithProviders";
import type { FaceGroup, SerializedFace } from "../../types/api";
import People from "../People";

vi.mock("../../services/api/WorkerApiClient", () => ({
  workerApiClient: {
    getMe: vi.fn(),
    getPeople: vi.fn(),
    getFaceGroups: vi.fn(),
    createPerson: vi.fn(),
    assignFaces: vi.fn(),
    matchPersonAll: vi.fn(),
    setPersonLabel: vi.fn(),
    clearPersonLabel: vi.fn(),
    ignoreFaces: vi.fn(),
    restoreFaces: vi.fn(),
    getIgnoredFaces: vi.fn(),
    getReviewQueue: vi.fn(),
    thumbnailUrl: vi.fn(
      (f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`,
    ),
  },
}));

function face(
  id: string,
  overrides: Partial<SerializedFace> = {},
): SerializedFace {
  return {
    id,
    photoId: `p-${id}`,
    thumbnailUrl: "/thumbnails/h1",
    bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    detScore: 0.99,
    personId: null,
    personName: null,
    status: "unassigned",
    matchScore: null,
    ...overrides,
  };
}

const people = [
  {
    id: "pe1",
    name: "Asha",
    faceCount: 3,
    photoCount: 2,
    canEdit: true,
    cover: face("c1"),
  },
  {
    id: "pe2",
    name: "Ravi",
    faceCount: 1,
    photoCount: 1,
    canEdit: true,
    cover: null,
  },
];
const group = (...ids: string[]): FaceGroup => ({
  faces: ids.map((i) => face(i)),
});

const show = () =>
  renderWithProviders(<People />, { route: "/people", path: "/people" });

describe("People", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({
      email: "owner@example.com",
      admin: false,
    });
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation(
      (f) => `/api${f.thumbnailUrl}`,
    );
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([]);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [group("f1", "f2")],
      scanned: 2,
      nextCursor: null,
    });
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({
      matched: 0,
      truncated: false,
    });
  });

  it('shows a named spinner while loading', async () => {
    vi.mocked(workerApiClient.getPeople).mockReturnValue(new Promise(() => {}));
    show();
    expect(await screen.findByRole('progressbar', { name: 'Loading people' })).toBeInTheDocument();
  });

  it("sorts people alphabetically by default and by face count on request", async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      {
        id: "a",
        name: "Amy",
        faceCount: 1,
        photoCount: 1,
        canEdit: true,
        cover: null,
      },
      {
        id: "b",
        name: "Bo",
        faceCount: 5,
        photoCount: 2,
        canEdit: true,
        cover: null,
      },
    ]);
    show();
    const names = () =>
      screen
        .getAllByRole("link", { name: /faces?$/ })
        .map((l) => l.getAttribute("href"));
    await screen.findByRole("link", { name: /Amy/ });
    expect(names()).toEqual(["/people/a", "/people/b"]);
    fireEvent.click(screen.getByRole("button", { name: "Most faces" }));
    await waitFor(() => expect(names()).toEqual(["/people/b", "/people/a"]));
  });

  it("lists named people and unnamed groups", async () => {
    show();
    const link = await screen.findByRole("link", { name: /Asha/ });
    expect(link).toHaveAttribute("href", "/people/pe1");
    expect(screen.getByRole("link", { name: /Ravi/ })).toHaveAttribute(
      "href",
      "/people/pe2",
    );
    expect(screen.getByText(/3 faces/)).toBeInTheDocument();
    expect(await screen.findByText("Unnamed groups")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Name this group" }),
    ).toBeInTheDocument();
  });

  it("shows the largest faces of a group first", async () => {
    const sized = (id: string, w: number) =>
      face(id, { personName: id, bbox: { x: 0.1, y: 0.1, w, h: w } });
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [
        { faces: [sized("tiny", 0.05), sized("huge", 0.5), sized("mid", 0.2)] },
      ],
      scanned: 3,
      nextCursor: null,
    });
    show();
    const btn = await screen.findByRole("button", { name: "Name this group" });
    const card = btn.closest('[data-testid="face-group"]') as HTMLElement;
    expect(
      within(card)
        .getAllByTestId("face-tile")
        .map((t) => t.getAttribute("aria-label")),
    ).toEqual(["huge", "mid", "tiny"]);
  });

  it("shows at most 8 face tiles per group", async () => {
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [group(...Array.from({ length: 12 }, (_, i) => `g${i}`))],
      scanned: 12,
      nextCursor: null,
    });
    show();
    const btn = await screen.findByRole("button", { name: "Name this group" });
    const card = btn.closest('[data-testid="face-group"]') as HTMLElement;
    expect(within(card).getAllByTestId("face-tile")).toHaveLength(8);
  });

  it("naming a group calls createPerson with all its face ids", async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({
      id: "pe9",
      name: "Meera",
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.change(screen.getByLabelText("Person name"), {
      target: { value: " Meera " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(workerApiClient.createPerson).toHaveBeenCalledWith("Meera", [
        "f1",
        "f2",
      ]),
    );
  });

  it("naming a group then runs matchPersonAll", async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({
      id: "pe9",
      name: "Meera",
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.change(screen.getByLabelText("Person name"), {
      target: { value: "Meera" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith(
        "pe9",
        expect.any(Function), []
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Name this group" }),
      ).toBeNull(),
    );
  });

  it("closes the named group without waiting for matching to finish", async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({
      id: "pe9",
      name: "Meera",
    });
    vi.mocked(workerApiClient.matchPersonAll).mockReturnValue(
      new Promise(() => {}),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.change(screen.getByLabelText("Person name"), {
      target: { value: "Meera" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Person name")).toBeNull(),
    );
  });

  it("keeps naming successful when matching fails", async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({
      id: "pe9",
      name: "Meera",
    });
    vi.mocked(workerApiClient.matchPersonAll).mockRejectedValue(
      new Error("boom"),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.change(screen.getByLabelText("Person name"), {
      target: { value: "Meera" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByText("Named, but could not look for more matches"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not save the name")).toBeNull();
  });

  it("shows a friendly message for a duplicate name", async () => {
    vi.mocked(workerApiClient.createPerson).mockRejectedValue(
      new Error("Request failed: 409"),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.change(screen.getByLabelText("Person name"), {
      target: { value: "Asha" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByText("That name already exists"),
    ).toBeInTheDocument();
    expect(workerApiClient.matchPersonAll).not.toHaveBeenCalled();
  });

  it("adding a group to an existing person calls assignFaces", async () => {
    vi.mocked(workerApiClient.assignFaces).mockResolvedValue();
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Name this group" }),
    );
    fireEvent.click(
      await screen.findByPlaceholderText("Or add to an existing person"),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Ravi" }));
    await waitFor(() =>
      expect(workerApiClient.assignFaces).toHaveBeenCalledWith("pe2", [
        "f1",
        "f2",
      ]),
    );
    await waitFor(() =>
      expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith(
        "pe2",
        expect.any(Function), []
      ),
    );
  });

  it("loads further group pages only as needed and pages them like other lists", async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        group(`${prefix}${i}a`, `${prefix}${i}b`),
      );
    vi.mocked(workerApiClient.getFaceGroups)
      .mockResolvedValueOnce({
        groups: many("x", 6),
        scanned: 100,
        nextCursor: "cur1",
      })
      .mockResolvedValueOnce({
        groups: many("y", 3),
        scanned: 20,
        nextCursor: null,
      });
    show();
    expect(
      await screen.findAllByRole("button", { name: "Name this group" }),
    ).toHaveLength(6);
    expect(screen.getByText("Showing 1-6 of 6+")).toBeInTheDocument();
    expect(workerApiClient.getFaceGroups).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() =>
      expect(workerApiClient.getFaceGroups).toHaveBeenLastCalledWith("cur1"),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Name this group" }),
      ).toHaveLength(3),
    );
    expect(screen.getByText("Showing 7-9 of 9")).toBeInTheDocument();
  });

  it("pages the named people", async () => {
    const lots = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`,
      name: `Person ${String(i).padStart(2, "0")}`,
      faceCount: 14 - i,
      photoCount: 1,
      canEdit: true,
      cover: face(`c${i}`),
    }));
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(lots);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [],
      scanned: 0,
      nextCursor: null,
    });
    show();
    expect(
      await screen.findByRole("link", { name: /Person 00/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Person 13/ })).toBeNull();
    expect(screen.getByText("Showing 1-12 of 14")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(
      await screen.findByRole("link", { name: /Person 13/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Person 00/ })).toBeNull();
  });

  it("keeps the chosen sort when moving to the second page", async () => {
    // Most faces first reverses the alphabetical order: Person 13 leads, Person 00 is last.
    const lots = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`,
      name: `Person ${String(i).padStart(2, "0")}`,
      faceCount: i + 1,
      photoCount: 1,
      canEdit: true,
      cover: null,
    }));
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(lots);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [],
      scanned: 0,
      nextCursor: null,
    });
    show();
    await screen.findByRole("link", { name: /Person 00/ });
    fireEvent.click(screen.getByRole("button", { name: "Most faces" }));
    await screen.findByRole("link", { name: /Person 13/ });
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    // Page 2 of "most faces" holds the two smallest, and the select still says so.
    expect(
      await screen.findByRole("link", { name: /Person 00/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Person 13/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Most faces" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows each person with their cover face and name", async () => {
    show();
    const link = await screen.findByRole("link", { name: /Asha/ });
    expect(within(link).getByTestId("face-tile")).toBeInTheDocument();
    expect(within(link).getByText("Asha")).toBeInTheDocument();
  });

  it("shows an empty state when no faces exist yet", async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [],
      scanned: 0,
      nextCursor: null,
    });
    show();
    expect(await screen.findByText(/No faces yet/)).toBeInTheDocument();
  });

  it("hides naming controls for a viewer, whose unnamed groups the Worker returns empty", async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({
      email: "viewer@example.com",
      admin: false,
    });
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [],
      scanned: 0,
      nextCursor: null,
    });
    show();
    await screen.findByRole("link", { name: /Asha/ });
    expect(screen.queryByText("Unnamed groups")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Name this group" }),
    ).not.toBeInTheDocument();
  });

  describe("viewer-private names", () => {
    const shared = [
      {
        id: "pe1",
        name: null,
        faceCount: 3,
        photoCount: 2,
        canEdit: false,
        cover: null,
      },
      {
        id: "pe2",
        name: "Mum",
        faceCount: 1,
        photoCount: 1,
        canEdit: false,
        cover: null,
      },
      {
        id: "pe3",
        name: "Mine",
        faceCount: 1,
        photoCount: 1,
        canEdit: true,
        cover: null,
      },
    ];
    beforeEach(() => {
      vi.mocked(workerApiClient.getPeople).mockResolvedValue(shared);
      vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
        groups: [],
        scanned: 0,
        nextCursor: null,
      });
    });

    it("shows Unnamed person for an unlabeled person, and offers the label editor only for people the caller does not own", async () => {
      show();
      expect(await screen.findByText("Unnamed person")).toBeInTheDocument();
      expect(screen.getByText("Mum")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /my name/ })).toHaveLength(
        2,
      );
      expect(
        screen.getByRole("button", { name: "Add my name" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Edit my name" }),
      ).toBeInTheDocument();
    });

    it("saves a label through setPersonLabel", async () => {
      vi.mocked(workerApiClient.setPersonLabel).mockResolvedValue();
      show();
      fireEvent.click(
        await screen.findByRole("button", { name: "Add my name" }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "My name for this person" }),
        { target: { value: "  Aunt " } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Save my name" }));
      await waitFor(() =>
        expect(workerApiClient.setPersonLabel).toHaveBeenCalledWith(
          "pe1",
          "Aunt",
        ),
      );
      expect(workerApiClient.clearPersonLabel).not.toHaveBeenCalled();
    });

    it("clears the label when the text is emptied, and shows a clash", async () => {
      vi.mocked(workerApiClient.clearPersonLabel).mockResolvedValue();
      show();
      fireEvent.click(
        await screen.findByRole("button", { name: "Edit my name" }),
      );
      const box = screen.getByRole("textbox", {
        name: "My name for this person",
      });
      expect(box).toHaveValue("Mum");
      fireEvent.change(box, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save my name" }));
      await waitFor(() =>
        expect(workerApiClient.clearPersonLabel).toHaveBeenCalledWith("pe2"),
      );
    });

    it("reports a 409 clash", async () => {
      vi.mocked(workerApiClient.setPersonLabel).mockRejectedValue(
        new Error("Could not save: 409"),
      );
      show();
      fireEvent.click(
        await screen.findByRole("button", { name: "Add my name" }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "My name for this person" }),
        { target: { value: "Mum" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Save my name" }));
      expect(
        await screen.findByText("That name already exists"),
      ).toBeInTheDocument();
    });
  });
});

describe("People: ignoring faces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation(
      (f) => `/api${f.thumbnailUrl}`,
    );
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [group("f1", "f2")],
      scanned: 2,
      nextCursor: null,
    });
    vi.mocked(workerApiClient.ignoreFaces).mockResolvedValue();
    vi.mocked(workerApiClient.restoreFaces).mockResolvedValue();
  });

  it("ignores a whole group and drops the card without refetching groups", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Ignore group" }));
    await waitFor(() =>
      expect(screen.queryByTestId("face-group")).toBeNull(),
    );
    expect(workerApiClient.ignoreFaces).toHaveBeenCalledWith(["f1", "f2"]);
    expect(workerApiClient.getFaceGroups).toHaveBeenCalledTimes(1);
    expect(workerApiClient.matchPersonAll).not.toHaveBeenCalled();
  });

  it("ignores one face and keeps the rest of the group", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Ignore face 2 of 2" }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("face-tile").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(screen.getByText("1 face")).toBeInTheDocument(),
    );
    expect(workerApiClient.ignoreFaces).toHaveBeenCalledWith(["f2"]);
  });

  it("keeps the group and says so when ignoring fails", async () => {
    vi.mocked(workerApiClient.ignoreFaces).mockRejectedValue(new Error("boom"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Ignore group" }));
    expect(
      await screen.findByText("Something went wrong, try again"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("face-group")).toBeInTheDocument();
  });

  it("loads ignored faces only when opened, and restores one or all shown", async () => {
    vi.mocked(workerApiClient.getIgnoredFaces).mockResolvedValue({
      faces: [face("x1", { ignored: true }), face("x2", { ignored: true })],
      nextCursor: null,
    });
    show();
    await screen.findByTestId("face-group");
    expect(workerApiClient.getIgnoredFaces).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ignored faces" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore ignored face 2" }),
    );
    await waitFor(() =>
      expect(workerApiClient.restoreFaces).toHaveBeenCalledWith(["x2"]),
    );
    await waitFor(() =>
      expect(workerApiClient.getFaceGroups).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Restore all shown" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore all shown" }));
    await waitFor(() =>
      expect(workerApiClient.restoreFaces).toHaveBeenCalledWith(["x1", "x2"]),
    );
  });

  it("pages ignored faces and says when there are none", async () => {
    vi.mocked(workerApiClient.getIgnoredFaces)
      .mockResolvedValueOnce({
        faces: [face("x1", { ignored: true })],
        nextCursor: "t|1",
      })
      .mockResolvedValueOnce({
        faces: [face("x2", { ignored: true })],
        nextCursor: null,
      });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Ignored faces" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("button", { name: "Restore ignored face 2" }),
    ).toBeInTheDocument();
    expect(workerApiClient.getIgnoredFaces).toHaveBeenLastCalledWith("t|1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says when nothing is ignored", async () => {
    vi.mocked(workerApiClient.getIgnoredFaces).mockResolvedValue({
      faces: [],
      nextCursor: null,
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Ignored faces" }),
    );
    expect(await screen.findByText("No ignored faces.")).toBeInTheDocument();
  });

  it("links to the matches waiting for review, with their total", async () => {
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([
      { id: "pe1", count: 300 },
      { id: "pe2", count: 12 },
    ]);
    show();
    expect(
      await screen.findByRole("link", { name: "312 matches to review" }),
    ).toHaveAttribute("href", "/review");
  });

  it("shows no review link when nothing is pending or the request fails", async () => {
    vi.mocked(workerApiClient.getReviewQueue).mockRejectedValue(new Error("500"));
    show();
    await screen.findByText("Asha");
    await waitFor(() => expect(workerApiClient.getReviewQueue).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /to review/ })).toBeNull();
  });

  const showWithHistory = (entry = "/people") =>
    renderWithRouter(
      [
        { path: "/people", element: <People /> },
        { path: "/elsewhere", element: <p>elsewhere</p> },
      ],
      [entry],
    );
  const manyGroups = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => group(`${prefix}${i}a`));

  it("keeps the unnamed groups page and the opened ignored faces after Back", async () => {
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: manyGroups("x", 9),
      scanned: 9,
      nextCursor: null,
    });
    vi.mocked(workerApiClient.getIgnoredFaces).mockResolvedValue({
      faces: [],
      nextCursor: null,
    });
    const { router } = showWithHistory();
    await screen.findByText("Showing 1-6 of 9");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await screen.findByText("Showing 7-9 of 9");
    expect(router.state.location.search).toBe("?groups=2");
    fireEvent.click(screen.getByRole("button", { name: "Ignored faces" }));
    await screen.findByText("No ignored faces.");
    await leaveAndGoBack(router);
    expect(await screen.findByText("Showing 7-9 of 9")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ignored faces" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("loads up to the groups page in the address instead of falling back to the first", async () => {
    vi.mocked(workerApiClient.getFaceGroups)
      .mockResolvedValueOnce({
        groups: manyGroups("x", 6),
        scanned: 100,
        nextCursor: "cur1",
      })
      .mockResolvedValueOnce({
        groups: manyGroups("y", 6),
        scanned: 100,
        nextCursor: "cur2",
      })
      .mockResolvedValueOnce({
        groups: manyGroups("z", 3),
        scanned: 20,
        nextCursor: null,
      });
    const { router } = showWithHistory("/people?groups=3");
    expect(await screen.findByText("Showing 13-15 of 15")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?groups=3");
  });
});
