import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTheme } from "@emotion/react";
import { Radio, Search } from "lucide-react";
import { PageFrame } from "@/components/Structure/PageFrame";
import { StatTile } from "@/components/dashboard/StatTile";
import { RefreshButton } from "@/components/table/RefreshButton";
import {
  useNamespaces,
  useSubstrateActors,
  useSubstrateSummary,
  useSubstrateWorkers,
  type SubstrateActorEntry,
  type SubstrateActorTemplateEntry,
  type SubstrateWorkerEntry,
  type SubstrateWorkerPoolEntry,
} from "@/api";

const { Text } = Typography;

/**
 * How tall the actor and worker tables get before they scroll internally.
 *
 * These two lists are the only ones here whose length is set by the cluster rather
 * than by configuration, and ate-api will hand over as many as exist: a real cluster
 * answered with 34,356 actors, which unbounded came to a 1.4-million-pixel page that
 * took seconds to become interactive and could not even be screenshotted. Bounding
 * the body and letting antd window the rows keeps the page a fixed size whatever the
 * backend reports.
 */
const GROWING_TABLE_HEIGHT = 420;

/**
 * The interval polling starts at, in seconds.
 *
 * A second is quick enough to watch an actor move between workers and slow enough to
 * leave running while reading, which is what this control is for.
 */
const DEFAULT_POLL_SECONDS = 1;

/**
 * The fastest this page will ask, in seconds.
 *
 * Below this the reader is not watching a cluster, they are load-testing one. The two
 * list reads are pages now and are cheap, but the summary is not: ate-api reports no
 * totals, so the controller walks every one of its pages to count, and on a cluster
 * holding 410,110 actors that walk is seconds. Enforced on the field rather than only
 * in the timer, so the number on screen is the number being used.
 */
const MIN_POLL_SECONDS = 0.5;

/**
 * What a poll interval means, given whatever is in the field.
 *
 * `null` is an empty or unparseable field — antd hands back `null` for "." and for a
 * cleared input — and zero is a deliberate stop. Both mean the same thing here: the
 * toggle can stay on without a timer running behind it, so a reader who wants to pause
 * without losing their place has a way to.
 *
 * Anything faster than the floor is read as the floor rather than refused, so a
 * half-typed "0.1" polls at 0.5 instead of hammering the controller for the moment
 * before the field is corrected.
 */
function pollIntervalMs(seconds: number | null): number | undefined {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(seconds, MIN_POLL_SECONDS) * 1000;
}

/** Where the chosen scope lives, so a link carries what the reader is looking at. */
const NAMESPACE_PARAM = "namespace";

/**
 * The scope that means "everything the controller watches".
 *
 * `GetSubstrateStatusRequest.namespace` is empty for it — `substrateNamespaces("")` in
 * the controller expands that to its observed namespaces — so the absence of the URL
 * param and the absence of the field are the same fact, and neither needs a sentinel.
 */
const ALL_NAMESPACES = "";

/**
 * What a status or phase is telling you, as four readings rather than a dozen strings.
 *
 * The substrate's vocabulary is not a closed enum on the wire: `phase` and `status` are
 * plain strings that ate-api and the ActorTemplate controller each fill in their own way,
 * so this classifies rather than switches. Anything unrecognised falls through to
 * `neutral` and is shown as it arrived — inventing a colour for a word this page has
 * never seen would be a claim about health nobody made.
 */
type StatusTone = "healthy" | "warning" | "progress" | "idle" | "neutral";

function statusTone(label: string): StatusTone {
  const value = label.trim().toLowerCase();
  if (value === "ready" || value === "running") return "healthy";
  if (value === "failed" || value === "suspending") return "warning";
  if (value === "suspended" || value === "unknown" || value === "") return "idle";
  // Substrings, because these arrive spelled several ways: `Resuming`, `WaitingForWorker`,
  // `GoldenSnapshotPending`. All of them mean the same thing to a reader — something is
  // under way and the next read will say something different.
  if (value.includes("resume") || value.includes("wait") || value.includes("golden")) {
    return "progress";
  }
  return "neutral";
}

/**
 * A status, coloured by what it means.
 *
 * The triples are the theme's own rather than antd's presets, for the reason the palette
 * states: antd derives a tag's three colours from one foreground token on the assumption
 * of a light page. `primary` is not among them in any tone — it is a fill chosen to carry
 * light text, and as ink on this page it measures about 2.2:1.
 */
function StatusChip({ label }: { label: string }) {
  const theme = useTheme();
  const tone = statusTone(label);

  const pill = {
    healthy: {
      background: theme.color.successBg,
      borderColor: theme.color.successBorder,
      color: theme.color.successText,
    },
    warning: {
      background: theme.color.warningBg,
      borderColor: theme.color.warningBorder,
      color: theme.color.warningText,
    },
    progress: {
      background: theme.color.infoBg,
      borderColor: theme.color.infoBorder,
      color: theme.color.infoText,
    },
    idle: {
      background: theme.color.bgElevated,
      borderColor: theme.color.border,
      color: theme.color.textMuted,
    },
    neutral: {
      background: theme.color.bgElevated,
      borderColor: theme.color.borderStrong,
      color: theme.color.text,
    },
  }[tone];

  return (
    <Tag
      css={{
        ...pill,
        /*
         * The substrate's vocabulary is open-ended: `phase` and `status` are plain
         * strings, and a value this build has never seen is shown as it arrived. Some
         * of them are long — a cluster answered with `ACTOR_STATE_CRASHED`, which at
         * one line overflowed its column and printed itself across the next one. So
         * the tag wraps inside the width it is given rather than spilling out of it.
         */
        whiteSpace: "normal",
        maxWidth: "100%",
        wordBreak: "break-word",
      }}
      data-tone={tone}
    >
      {label.trim() === "" ? "not reported" : label}
    </Tag>
  );
}

/**
 * A section's name and how many rows are under it, which is worth knowing before
 * reading them.
 *
 * Both numbers whenever the rows on screen are not the whole answer — because a
 * search has narrowed them, or because they are one page of many. A bare count is
 * how a reader concludes their cluster has three actors when it is running four
 * hundred thousand, and with the lists paged that is now the *default* case rather
 * than an edge one.
 *
 * The total is the server's, never `rows.length`. That is the whole reason the
 * summary RPC exists: a page cannot count what it did not fetch.
 */
function SectionTitle({
  title,
  count,
  total,
}: {
  title: string;
  /** How many rows are on screen. */
  count: number;
  /** How many there are in total, counted server-side. */
  total?: number;
}) {
  const theme = useTheme();
  const narrowed = total !== undefined && total !== count;
  return (
    <Space size={8}>
      <span>{title}</span>
      <Text css={{ color: theme.color.textMuted, fontWeight: 400 }}>
        {narrowed ? `${count} of ${total.toLocaleString()}` : count}
      </Text>
    </Space>
  );
}

/**
 * A paged section's heading, which has two counts to tell apart.
 *
 * Unsearched, the honest sentence is "100 of 4,312": this page's rows, against the
 * total the summary counted server-side. Searched, it is "3 of 100 on this page" —
 * because the search reached one page, and rendering "3 of 4,312" would say it had
 * been run against the cluster. That second sentence is the one that matters: a
 * reader who searches for an actor sitting on page nine is told there are no matches
 * here, not that there are none.
 *
 * With no total at all — the summary failed while the page read succeeded, which is
 * why they are separate reads — the count keeps "on this page". A bare "100" is the
 * one thing this component exists to prevent: it is indistinguishable from a total,
 * and it would be claiming a cluster of 410,110 actors is running a hundred.
 */
function PagedSectionTitle({
  title,
  shown,
  onPage,
  total,
  searching,
}: {
  title: string;
  /** Rows after the search box. */
  shown: number;
  /** Rows the page arrived with. */
  onPage: number;
  /** Rows in scope across every page, counted server-side. */
  total?: number;
  searching: boolean;
}) {
  const theme = useTheme();
  const count = searching
    ? `${shown} of ${onPage} on this page`
    : total === undefined
      ? `${onPage} on this page`
      : total === onPage
        ? String(onPage)
        : `${onPage} of ${total.toLocaleString()}`;

  return (
    <Space size={8}>
      <span>{title}</span>
      <Text css={{ color: theme.color.textMuted, fontWeight: 400 }}>{count}</Text>
    </Space>
  );
}

/**
 * Narrows one section's rows by what the reader typed.
 *
 * Per section rather than one box for the page, because these four lists answer four
 * different questions: narrowing the actors to one template should not also empty the
 * table that says what that template is.
 *
 * Matching is a substring of everything the row shows, case-insensitively. A row's own
 * text is built by the caller so the search covers what is on screen — including the
 * parts a column composes, like a pod and its IP — rather than a field list that drifts
 * from the columns beside it.
 */
function filterRows<T>(
  rows: readonly T[],
  query: string,
  text: (row: T) => string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => text(row).toLowerCase().includes(needle));
}

/**
 * A column comparator over whatever string the column shows.
 *
 * `localeCompare` rather than `<`, so a list of names sorts the way the reader reads
 * them. Every column gets one and every one carries a `multiple`, which is what makes
 * the tables multi-sortable: antd sorts by each active column in `multiple` order, so
 * shift-clicking Status then Template groups by status and orders within each group.
 */
function byText<T>(of: (row: T) => string) {
  return (a: T, b: T) => of(a).localeCompare(of(b));
}

/** The same, for a column showing a number, which must not sort as one. */
function byNumber<T>(of: (row: T) => number) {
  return (a: T, b: T) => of(a) - of(b);
}

/**
 * A paged table's rows: what arrived, and what is left of it after the search box.
 *
 * Both, because the heading needs to tell them apart — "3 of 100 on this page" is a
 * different claim from "100 of 4,312", and only one of them is true at a time.
 *
 * One hook for both tables rather than four memos, so the two cannot drift into
 * filtering or ordering by different rules. Memoised because this page can be polling:
 * filtering and sorting in the render body would run on every tick whether or not
 * anything changed.
 */
function usePagedRows<Row>(
  // Only the failure is read from the resource; the rows are passed separately
  // because which field holds them differs between the two.
  read: { error?: unknown },
  rows: readonly Row[] | undefined,
  query: string,
  text: (row: Row) => string,
  key: (row: Row) => string,
): { page: readonly Row[]; shown: Row[] } {
  // A failed read shows no rows: its banner says why, and leaving the previous page
  // underneath it would date the table without dating the message above it.
  const page = useMemo(
    () => (read.error ? [] : (rows ?? [])),
    [read.error, rows],
  );
  const shown = useMemo(
    () => orderedBy(filterRows(page, query, text), key),
    // `text` and `key` are declared inline by the caller, so they are new on every
    // render and deliberately not dependencies: what decides these rows is the page
    // and the term.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, query],
  );
  return { page, shown };
}

/**
 * The order a paged table's rows are in before a reader clicks anything.
 *
 * ate-api returns actors and workers in whatever order it holds them, which is not an
 * order: the same rows come back arranged differently from one read to the next, so a
 * page that polls has rows moving under the pointer while they are being read. antd
 * sorts by an active column and otherwise leaves `dataSource` alone, so this is what
 * `dataSource` has to arrive as.
 *
 * A copy, because `sort` is in place and the array belongs to the SWR cache.
 */
function orderedBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((left, right) => key(left).localeCompare(key(right)));
}

/**
 * A section's search box.
 *
 * In the card's own corner rather than above the page: it belongs to the table it
 * filters, and a reader who has typed into it can see which list went quiet.
 */
function SectionSearch({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    // The id is on a wrapper this app owns rather than on the control: antd spreads
    // unknown props onto its inner input, so an id there is an assertion about their
    // markup. The same reason the scope Select and the polling interval are wrapped.
    <div data-testid={testId}>
      <Input
        allowClear
        size="small"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onClear={() => onChange("")}
        aria-label={label}
        placeholder="Search"
        prefix={<Search size={13} color={theme.color.textMuted} aria-hidden />}
        css={{ width: 200 }}
      />
    </div>
  );
}

/** Where a section's rows come from, said once beside the section rather than per row. */
function SectionHint({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text css={{ color: theme.color.textMuted, fontSize: 12, fontWeight: 400 }}>
      {children}
    </Text>
  );
}

/**
 * The Agent Substrate's own inventory.
 *
 * Four sections, in the order a reader needs them: the worker pools sandboxes run on and
 * the templates actors are cut from, both read from Kubernetes; then the actors placed
 * right now and the pods they are placed on, both read from ate-api. The split matters
 * more than it looks — the Kubernetes halves are complete whenever the request succeeded,
 * while the ate-api halves can be absent (`enabled: false`, no endpoint configured) or
 * partial (`ateApiError` on an otherwise successful response). Each of those is said in
 * the place it applies rather than as one banner over everything.
 */

/**
 * How many rows a paged section asks for.
 *
 * The controller's maximum, because these tables are virtualised and bounded in
 * height: a bigger page costs nothing to render and means fewer round trips for a
 * reader scrolling through actors. It is also how much the sort and the search below
 * cover, which is the other reason to ask for as many as allowed. Anything above 100
 * is refused outright rather than clamped.
 */
const PAGE_SIZE = 100;

/**
 * A paged section's position, as a stack of the tokens that got us here.
 *
 * A stack rather than a page number, because the API pages by token: the only way
 * back to the previous page is the token that produced it. Reset whenever the
 * question changes — which now means only the scope, since the sort and the search
 * are applied to the page in hand and change nothing about which rows it holds.
 */
function usePageStack(resetKey: string) {
  const [state, setState] = useState<{ key: string; tokens: string[] }>({
    key: resetKey,
    tokens: [],
  });

  /*
   * The reset is derived, not performed.
   *
   * Clearing the stack from an effect would be a `setState` inside one — a cascading
   * render, and the rule that forbids it is right — and it would also render one
   * frame of the *old* page against the new question before correcting itself.
   * Reading the key alongside the tokens means a changed question is already on the
   * first page in the render that discovers it.
   */
  const tokens = state.key === resetKey ? state.tokens : [];

  return {
    /** The token for the page being shown. Empty is the first page. */
    current: tokens.length > 0 ? tokens[tokens.length - 1] : "",
    pageNumber: tokens.length + 1,
    canGoBack: tokens.length > 0,
    next: (token: string) =>
      setState({ key: resetKey, tokens: [...tokens, token] }),
    back: () => setState({ key: resetKey, tokens: tokens.slice(0, -1) }),
  };
}

/**
 * What the sort and the search on a paged table actually reach, said beside it.
 *
 * The claim this replaced was "Sorted across the whole inventory", which was true of
 * the read it stood over: that read fetched every actor and ordered all of them before
 * the browser sliced out a page. It could not survive a large cluster — one response
 * of 410,110 actors is roughly 43MB against gRPC's 16MB ceiling — so the read is a
 * page now, and the sentence has to be.
 *
 * What replaced it is narrower and true: the columns sort the hundred rows in front of
 * the reader, and the search box narrows the same hundred. ate-api offers paging and
 * nothing else — no order, no filter — so ordering the cluster would mean reading the
 * cluster, which is the thing that could not be done. Saying so is what keeps a reader
 * from concluding, from an empty search, that their cluster has no such actor.
 *
 * The age is here for a related reason: a page that showed a stale answer while
 * claiming to poll would be the polling bug this codebase has already shipped once.
 */
function PageScopeNote({
  computedAt,
  testId,
}: {
  computedAt?: string;
  testId: string;
}) {
  const theme = useTheme();
  const age = useDataAge(computedAt);

  return (
    <Text
      data-testid={testId}
      css={{ color: theme.color.textMuted, fontSize: 12 }}
    >
      Sorting and search apply to this page only
      {age ? ` · ${age}` : ""}
    </Text>
  );
}

/**
 * How old an answer is, in words, ticking as it ages.
 *
 * A clock of its own, because nothing else re-renders while the page sits idle: a
 * stale figure with no ticking age beside it is indistinguishable from a live one.
 */
function useDataAge(computedAt: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  if (!computedAt) return "";
  const at = new Date(computedAt).getTime();
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 1) return "read just now";
  return `read ${seconds.toFixed(1)}s ago`;
}

/**
 * An ate-api failure that reached one page and not the whole read.
 *
 * `ListSubstrateActors` answers with an empty page and this string rather than failing,
 * for the same reason the summary does: the call succeeded, and only the runtime half
 * of it is missing. Without a sentence here that page is an empty table beside a tile
 * reporting four hundred thousand actors, which reads as a bug in the tile.
 */
function PageWarning({ message, testId }: { message: string; testId: string }) {
  return (
    <Alert
      type="warning"
      showIcon
      title="This page could not be read from ate-api"
      description={message}
      data-testid={testId}
    />
  );
}

/** Previous and Next for one paged section, with the page number between them. */
function PageControls({
  testId,
  page,
  hasNext,
  onNext,
  onBack,
  isLoading,
}: {
  testId: string;
  page: { pageNumber: number; canGoBack: boolean };
  hasNext: boolean;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
}) {
  const theme = useTheme();

  // Nothing to page through: one page and no way off it. Hidden rather than shown
  // disabled, because two dead buttons under a five-row table read as a broken
  // control rather than as a complete list.
  if (!hasNext && !page.canGoBack) return null;

  return (
    <Space size={8} css={{ marginTop: theme.space(3) }} data-testid={testId}>
      <Button
        size="small"
        disabled={!page.canGoBack || isLoading}
        onClick={onBack}
        data-testid={`${testId}-prev`}
      >
        Previous
      </Button>
      <Text css={{ color: theme.color.textMuted, fontSize: 12 }}>
        Page {page.pageNumber}
      </Text>
      <Button
        size="small"
        disabled={!hasNext || isLoading}
        onClick={onNext}
        data-testid={`${testId}-next`}
      >
        Next
      </Button>
    </Space>
  );
}

/**
 * The Agent Substrate's own inventory.
 *
 * Four sections, in the order a reader needs them: the worker pools sandboxes run on
 * and the templates actors are cut from, both read from Kubernetes; then the actors
 * placed right now and the pods they are placed on, both read from ate-api. The split
 * matters more than it looks — the Kubernetes halves are complete whenever the request
 * succeeded, while the ate-api halves can be absent (`enabled: false`, no endpoint
 * configured) or partial (`ateApiError` on an otherwise successful response). Each of
 * those is said in the place it applies rather than as one banner over everything.
 *
 * ## Three reads, not one
 *
 * This page used to make a single call for the whole inventory, and it stopped
 * working: `GetSubstrateStatus` answers with every actor and every worker in one
 * message, and on a cluster reporting 410,110 actors that is a message gRPC refuses
 * to send — *"trying to send message larger than max"*. The page reported it honestly
 * as a failed read, which was right, and the read could not succeed.
 *
 * So it reads three things:
 *
 * - **the summary** (`GetSubstrateSummary`), for the tiles and for the two lists that
 *   are inherently small — worker pools and actor templates ride inline;
 * - **a page of actors** (`ListSubstrateActors`) and **a page of workers**
 *   (`ListSubstrateWorkers`), each passing a token through to ate-api's own paging.
 *
 * The split was cosmetic until the API caught up: all three used to call
 * `GetSubstrateStatus`, so a page of a hundred rows still cost the whole inventory and
 * still failed at the same size. Three reads that page are what makes it real.
 *
 * ## Where the counts come from, and why it matters
 *
 * Every total on this page is the summary's, counted server-side. None of them is
 * `rows.length`. With the lists paged, counting what arrived and calling it a total
 * would report a hundred actors for a cluster running four hundred thousand — the
 * exact failure the "3 of 4" rendering already existed to prevent, made far more
 * likely by paging.
 *
 * ## What the sorts and the searches reach
 *
 * The worker pool and actor template tables arrive whole, so sorting or searching
 * them covers all of them.
 *
 * The actor and worker tables do not, and their sort and search cover one page. That
 * is not a shortcut: ate-api's `ListActors` takes a page size and a token and offers
 * no order and no filter, so ordering or narrowing the cluster would mean reading the
 * cluster first — the read that could not succeed. Both tables say so beneath
 * themselves, both headings distinguish "3 of 100 on this page" from "100 of 4,312",
 * and an empty search says which pages it looked at. A reader who is told "no matches"
 * without being told what was searched will conclude the actor does not exist.
 */
export function SubstratePage() {
  const theme = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * The scope, from the URL rather than from state.
   *
   * So that a link to what someone is looking at is a link to what they are looking
   * at, and — the reason it is not remembered in storage — so one address is never
   * two different pages.
   */
  const namespace = searchParams.get(NAMESPACE_PARAM) ?? ALL_NAMESPACES;
  const scope = namespace === ALL_NAMESPACES ? undefined : namespace;

  const namespaces = useNamespaces();
  const summary = useSubstrateSummary(scope);

  /*
   * One search per section, and all four of them are applied here.
   *
   * What each one reaches is not the same, which is why the two paged tables say so
   * beside them. Worker pools and actor templates arrive whole in the summary, so a
   * search over them is a search over all of them. Actors and workers arrive one page
   * at a time — ate-api has no filter to push a search into, and pushing one into the
   * controller would mean reading every actor to apply it — so those two searches
   * narrow the page, and nothing here pretends otherwise.
   */
  const [poolQuery, setPoolQuery] = useState("");
  const [templateQuery, setTemplateQuery] = useState("");
  const [actorQuery, setActorQuery] = useState("");
  const [workerQuery, setWorkerQuery] = useState("");

  /*
   * Only the scope resets the page stacks.
   *
   * The sort and the search used to be in these keys, because both were part of the
   * read: each header click re-fetched the whole inventory to reorder rows the browser
   * was already holding. Neither travels now, so neither invalidates a token — a
   * reorder is a re-render.
   */
  const actorPage = usePageStack(namespace);
  const workerPage = usePageStack(namespace);

  const actors = useSubstrateActors({
    namespace: scope,
    limit: PAGE_SIZE,
    pageToken: actorPage.current,
  });
  const workers = useSubstrateWorkers({
    namespace: scope,
    limit: PAGE_SIZE,
    pageToken: workerPage.current,
  });

  /*
   * Off by default, and deliberately not remembered.
   *
   * Twice a second is a rate to watch something at, not a rate to leave a page at: a
   * remembered setting would have a tab left open in the background — or reopened
   * tomorrow — asking the controller for the inventory 7,000 times an hour for nobody.
   * Switching it on is cheap, so it is asked for each time it is wanted.
   */
  const [isPolling, setPolling] = useState(false);
  const [pollSeconds, setPollSeconds] = useState<number | null>(DEFAULT_POLL_SECONDS);
  const [behindAt, setBehindAt] = useState<number>();
  const pollMs = pollIntervalMs(pollSeconds);
  const isTicking = isPolling && pollMs !== undefined;
  const isBehind = isTicking && behindAt === pollMs;

  const isRefreshing =
    !isTicking &&
    (summary.isValidating ||
      actors.isValidating ||
      workers.isValidating ||
      namespaces.isValidating);

  /** What Refresh re-reads: the whole page, the list of namespaces included. */
  async function refreshAll(): Promise<void> {
    await Promise.all([
      summary.refresh(),
      actors.refresh(),
      workers.refresh(),
      namespaces.refresh(),
    ]);
  }

  /*
   * The timer lives here rather than in the data hooks, and re-reads the inventory
   * only.
   *
   * Driven from the page because `refresh` fetches directly, where the caching
   * layer's polling goes through revalidation — and revalidation is deduplicated by a
   * window that outlasts the interval, so asking it for twice a second produced a
   * read every two and a half. The page reported it was polling and it was not, which
   * is worse than not offering it.
   *
   * The namespace list is left alone: it is the page's scope control, not its data,
   * and it does not change twice a second.
   */
  /*
   * Not memoised, deliberately: the ref below is reassigned on every render, so this
   * is rebuilt each time either way — and a `useCallback` over three hook objects
   * would either capture a stale one or list dependencies that change every render,
   * which is the memoisation doing nothing while claiming to.
   */
  const refreshInventory = async () => {
    await Promise.all([summary.refresh(), actors.refresh(), workers.refresh()]);
  };

  const refreshRef = useRef(refreshInventory);
  // Assigned in an effect rather than during render: a ref written while rendering is
  // a value React is entitled to discard, and the lint rule that says so is right.
  useEffect(() => {
    refreshRef.current = refreshInventory;
  });
  const isTickInFlight = useRef(false);

  useEffect(() => {
    if (!isTicking || pollMs === undefined) return;

    const timer = window.setInterval(() => {
      // A tick that lands while the last one is still running is dropped rather than
      // stacked: against a backend slower than the interval, queueing would turn a
      // live view into a growing backlog of requests nobody is waiting for.
      if (isTickInFlight.current) {
        setBehindAt(pollMs);
        return;
      }
      isTickInFlight.current = true;
      void refreshRef
        .current()
        .catch(() => {
          // A failed read is already on screen as an error beside the data it belongs
          // to; there is nothing for the timer to add, and it must keep going either
          // way.
        })
        .finally(() => {
          isTickInFlight.current = false;
        });
    }, pollMs);

    return () => window.clearInterval(timer);
  }, [isTicking, pollMs]);

  // A failure has its own banner; leaving the rows and the counts out keeps the rest
  // of the page from also claiming the cluster is running nothing.
  const inventory = summary.error ? undefined : summary.data;
  const unread = summary.error ? "Could not be read" : undefined;

  /*
   * The two inline lists, filtered here because they arrive here whole.
   *
   * Memoised because this page can be polling: filtering inside the render would run
   * on every tick whether or not anything changed.
   */
  const pools = useMemo(
    () =>
      filterRows(inventory?.workerPools ?? [], poolQuery, (pool) =>
        [pool.namespace, pool.name, String(pool.replicas), pool.ateomImage].join(" "),
      ),
    [inventory?.workerPools, poolQuery],
  );

  const templates = useMemo(
    () =>
      filterRows(inventory?.actorTemplates ?? [], templateQuery, (template) =>
        [
          template.namespace,
          template.name,
          template.goldenActorId,
          template.phase,
          template.sandboxClass,
          template.workerSelector,
          template.harnessName,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    [inventory?.actorTemplates, templateQuery],
  );

  /*
   * The page of actors, and what is left of it after the search box.
   *
   * Both are kept, because the heading needs to say which is which: "3 of 100 on this
   * page" is a different claim from "100 of 4,312", and only one of them is true at a
   * time. Memoised because this page can be polling — filtering in the render body
   * would run on every tick whether or not anything changed.
   */
  const { page: actorPageRows, shown: actorRows } = usePagedRows(
    actors,
    actors.data?.actors,
    actorQuery,
    (actor) =>
      [
        actor.actorId,
        actor.status,
        actor.actorTemplateNamespace,
        actor.actorTemplateName,
        actor.ateomPodNamespace,
        actor.ateomPodName,
        actor.ateomPodIp,
      ]
        .filter(Boolean)
        .join(" "),
    // Status, then id. Two keys because the second breaks ties in the first: with
    // status alone, two Running actors could swap places between polls.
    (actor) => `${actor.status}\u0000${actor.actorId}`,
  );

  const { page: workerPageRows, shown: workerRows } = usePagedRows(
    workers,
    workers.data?.workers,
    workerQuery,
    (worker) =>
      [worker.workerNamespace, worker.workerPool, worker.workerPod, worker.ip]
        .filter(Boolean)
        .join(" "),
    (worker) => `${worker.workerPool}\u0000${worker.workerNamespace}/${worker.workerPod}`,
  );

  /*
   * The tiles, from the summary's own counts.
   *
   * Not derived from the rows on screen, and that is the point of the summary
   * existing: the rows are one page, and a page counted as a total is how a cluster
   * running 410,110 actors gets reported as running 100.
   */
  const readyTemplates = useMemo(() => {
    let ready = 0;
    for (const template of inventory?.actorTemplates ?? []) {
      if (template.phase?.toLowerCase() === "ready") ready += 1;
    }
    return ready;
  }, [inventory?.actorTemplates]);

  const mono = useMemo(
    () => ({ fontFamily: theme.font.mono, fontSize: 12 }),
    [theme.font.mono],
  );
  const muted = useMemo(() => ({ color: theme.color.textMuted }), [theme.color.textMuted]);

  /** `namespace/name`, with the namespace quieter than the name it qualifies. */
  const qualified = useCallback(
    (ns: string | undefined, name: string) => (
      <span css={mono}>
        {ns ? <span css={muted}>{ns}/</span> : null}
        {name}
      </span>
    ),
    [mono, muted],
  );

  /*
   * Every column of the two inline tables sorts, and every sorter carries a
   * `multiple` — antd applies each active sorter in that order, so shift-clicking two
   * headers sorts by both. The numbers are a fixed priority rather than click order,
   * so they are chosen to put the column worth *grouping* by first.
   *
   * A comparator here rather than a read, because these two lists arrive whole: the
   * summary carries every pool and every template, so sorting them in the browser
   * sorts all of them. The paged tables below wear the same header and reach only
   * their own page — see `PageScopeNote`.
   */
  const workerPoolColumns: ColumnsType<SubstrateWorkerPoolEntry> = useMemo(
    () => [
      {
        title: "Pool",
        key: "pool",
        sorter: { compare: byText((pool) => `${pool.namespace}/${pool.name}`), multiple: 3 },
        render: (_, pool) => qualified(pool.namespace, pool.name),
      },
      {
        title: "Replicas",
        key: "replicas",
        width: 110,
        // Numerically: as text, 10 replicas sort before 9.
        sorter: { compare: byNumber((pool) => pool.replicas), multiple: 2 },
        render: (_, pool) => pool.replicas,
      },
      {
        title: "Ateom image",
        key: "ateomImage",
        sorter: { compare: byText((pool) => pool.ateomImage), multiple: 1 },
        // The image tag is what an operator checks against a release, so it is not
        // truncated.
        render: (_, pool) => (
          <Text css={{ ...mono, ...muted, wordBreak: "break-all" }}>{pool.ateomImage}</Text>
        ),
      },
    ],
    [mono, muted, qualified],
  );

  const actorTemplateColumns: ColumnsType<SubstrateActorTemplateEntry> = useMemo(
    () => [
      {
        title: "Template",
        key: "template",
        sorter: { compare: byText((t) => `${t.namespace}/${t.name}`), multiple: 5 },
        render: (_, template) => (
          <div>
            {qualified(template.namespace, template.name)}
            {/* The golden actor is the snapshot every new actor of this template is
                cut from, so it is the one identifier worth carrying beside the name. */}
            {template.goldenActorId ? (
              <Text css={{ ...mono, ...muted, display: "block" }}>
                golden: {template.goldenActorId}
              </Text>
            ) : null}
          </div>
        ),
      },
      {
        title: "Phase",
        key: "phase",
        width: 130,
        sorter: { compare: byText((t) => t.phase ?? ""), multiple: 4 },
        render: (_, template) => <StatusChip label={template.phase ?? ""} />,
      },
      {
        title: "Sandbox class",
        key: "sandboxClass",
        width: 140,
        sorter: { compare: byText((t) => t.sandboxClass ?? ""), multiple: 3 },
        render: (_, template) => template.sandboxClass ?? "—",
      },
      {
        title: "Worker selector",
        key: "workerSelector",
        sorter: { compare: byText((t) => t.workerSelector ?? ""), multiple: 2 },
        render: (_, template) =>
          template.workerSelector ? (
            <Text css={{ ...mono, ...muted }}>{template.workerSelector}</Text>
          ) : (
            "—"
          ),
      },
      {
        // Text and not a link: the agents list has no namespace filter to send a
        // reader to, so a link here would land them on an unfiltered page and imply
        // otherwise.
        title: "Harness",
        key: "harness",
        sorter: { compare: byText((t) => t.harnessName ?? ""), multiple: 1 },
        render: (_, template) => template.harnessName ?? "—",
      },
    ],
    [mono, muted, qualified],
  );

  /*
   * The paged tables sort the same way the two inline ones do, and reach less by it.
   *
   * A comparator rather than `sorter: true`. The `true` form gives a column antd's
   * header while leaving the table nothing to reorder, which was right while a header
   * click was a new read: the read ordered every actor in the cluster and handed back
   * a slice of the ordering. That read cannot survive a large cluster, so a comparator
   * over the rows in hand is what is left — and what the note beneath the table says.
   *
   * `multiple` for the same reason as the inline tables: it makes shift-clicking two
   * headers sort by both, with the number fixing the priority rather than the click
   * order. Status first on the actors, pool first on the workers, because those are
   * the columns worth grouping by.
   */
  const actorColumns: ColumnsType<SubstrateActorEntry> = useMemo(
    () => [
      {
        title: "Actor",
        key: "actorId",
        sorter: { compare: byText((actor) => actor.actorId), multiple: 1 },
        width: 320,
        render: (_, actor) => <span css={mono}>{actor.actorId}</span>,
      },
      {
        title: "Status",
        key: "status",
        sorter: { compare: byText((actor) => actor.status), multiple: 4 },
        // Wide enough for the longest status seen on a real cluster
        // (`ACTOR_STATE_CRASHED`) without wrapping it to three lines.
        width: 190,
        render: (_, actor) => <StatusChip label={actor.status} />,
      },
      {
        title: "Template",
        key: "template",
        sorter: {
          compare: byText(
            (actor) =>
              `${actor.actorTemplateNamespace ?? ""}/${actor.actorTemplateName ?? ""}`,
          ),
          multiple: 3,
        },
        width: 260,
        render: (_, actor) =>
          actor.actorTemplateName
            ? qualified(actor.actorTemplateNamespace, actor.actorTemplateName)
            : "—",
      },
      {
        title: "Worker pod",
        key: "workerPod",
        sorter: {
          compare: byText(
            (actor) => `${actor.ateomPodNamespace ?? ""}/${actor.ateomPodName ?? ""}`,
          ),
          multiple: 2,
        },
        width: 320,
        render: (_, actor) =>
          actor.ateomPodName ? (
            <Text css={{ ...mono, ...muted }}>
              {actor.ateomPodNamespace ?? ""}/{actor.ateomPodName}
              {actor.ateomPodIp ? ` · ${actor.ateomPodIp}` : ""}
            </Text>
          ) : (
            "—"
          ),
      },
    ],
    [mono, muted, qualified],
  );

  /*
   * The same, for the workers.
   *
   * There is no Actor column, and that is not an omission. ate-api's `Worker` carries
   * capacity and allocation and no actor reference: the binding lives on the *actor*,
   * so the only way to fill that column is to read every actor in the cluster and join
   * — the read this page stopped doing. The column stood here reading "idle" for every
   * worker on every real cluster, and looked populated only against a fixture that had
   * invented the field. How much of the fleet is busy is on a tile instead, where the
   * summary counts it once.
   */
  const workerColumns: ColumnsType<SubstrateWorkerEntry> = useMemo(
    () => [
      {
        title: "Pod",
        key: "pod",
        sorter: {
          compare: byText((worker) => `${worker.workerNamespace}/${worker.workerPod}`),
          multiple: 1,
        },
        width: 420,
        render: (_, worker) => qualified(worker.workerNamespace, worker.workerPod),
      },
      {
        title: "Pool",
        key: "pool",
        sorter: { compare: byText((worker) => worker.workerPool), multiple: 2 },
        width: 260,
        render: (_, worker) => worker.workerPool,
      },
      {
        title: "IP",
        key: "ip",
        sorter: { compare: byText((worker) => worker.ip ?? ""), multiple: 3 },
        width: 200,
        render: (_, worker) =>
          worker.ip ? (
            <Text css={{ ...mono, ...muted }}>{worker.ip}</Text>
          ) : (
            <Text css={muted}>—</Text>
          ),
      },
    ],
    [mono, muted, qualified],
  );

  const ateApiEnabled = inventory?.enabled ?? false;

  return (
    <PageFrame
      title="Substrate"
      description="Worker pools and actor templates from Kubernetes, plus live actors and worker assignments from ate-api."
      actions={
        <Space size={8}>
          <Tooltip
            title={
              isTicking
                ? `Re-reading the inventory every ${pollSeconds}s, so an actor moving between workers is visible as it happens.`
                : "Re-read the inventory on a timer, so an actor moving between workers is visible as it happens."
            }
          >
            <Button
              type={isTicking ? "primary" : "default"}
              aria-pressed={isPolling}
              onClick={() => setPolling((on) => !on)}
              data-testid="substrate-poll-toggle"
              icon={<Radio size={14} aria-hidden />}
            >
              Request polling: {isPolling ? "enabled" : "disabled"}
            </Button>
          </Tooltip>

          {/* Only while polling is on: an interval with nothing to drive is a control
              that reads as switched on when nothing is happening. */}
          {isPolling ? (
            <Tooltip
              title={`How often to re-read, in seconds. ${MIN_POLL_SECONDS}s is as fast as this page will ask; 0 stops without switching polling off.`}
            >
              {/* The test id is on a wrapper rather than on the control, the same as
                  the scope Select below: antd renders its own tree underneath and
                  spreads unknown props onto the inner input, so an id put here would
                  be asserting on their markup rather than ours. */}
              <div data-testid="substrate-poll-interval">
                <InputNumber
                  aria-label="Polling interval in seconds"
                  value={pollSeconds}
                  onChange={setPollSeconds}
                  /* The floor lands on blur rather than on every keystroke: applied as
                     typed, "0.1" would jump to "0.5" between the "." and the "1" and
                     fight the person entering it. */
                  onBlur={() =>
                    setPollSeconds((seconds) =>
                      seconds !== null && seconds > 0 && seconds < MIN_POLL_SECONDS
                        ? MIN_POLL_SECONDS
                        : seconds,
                    )
                  }
                  min={0}
                  /* No `step`: antd derives a display precision from it, which
                     rendered the default as "1.0". */
                  precision={undefined}
                  css={{ width: 132 }}
                  /* Singular for exactly one, because "1 seconds" beside a number the
                     reader chose looks like the page is not reading its own value.
                     `suffix` rather than `addonAfter`: antd 6 deprecates the latter. */
                  suffix={pollSeconds === 1 ? "second" : "seconds"}
                  status={isPolling && !isTicking ? "warning" : undefined}
                />
              </div>
            </Tooltip>
          ) : null}

          {isTicking && isBehind ? (
            <Tooltip title="The reads are taking longer than the interval, so some ticks are skipped rather than queued. A narrower scope, or a longer interval, gets an honest rate.">
              <Text
                data-testid="substrate-poll-behind"
                css={{ color: theme.color.warning, fontSize: 12 }}
              >
                reads slower than this rate
              </Text>
            </Tooltip>
          ) : null}

          <RefreshButton onRefresh={refreshAll} what="Substrate" loading={isRefreshing} />
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" css={{ display: "flex" }}>
        <Space size={8}>
          <Text css={muted}>Scope</Text>
          {/* The test id is on a wrapper rather than on the Select, because antd
              renders its own tree underneath and a prop that survives today is not
              something to assert on. The wrapper is this app's own markup. */}
          <div data-testid="substrate-namespace">
            <Select
              css={{ minWidth: 240 }}
              value={namespace}
              loading={namespaces.isLoading}
              onChange={(value: string) => {
                const next = new URLSearchParams(searchParams);
                if (value === ALL_NAMESPACES) next.delete(NAMESPACE_PARAM);
                else next.set(NAMESPACE_PARAM, value);
                // Replaced rather than pushed: changing scope is refining one
                // question, and a Back button that walks every refinement is one
                // nobody can use to leave the page.
                setSearchParams(next, { replace: true });
              }}
              options={[
                // First, and the default, because the substrate is a cluster-wide
                // thing and an operator arriving here wants to know what is running at
                // all.
                { value: ALL_NAMESPACES, label: "All watched namespaces" },
                ...(namespaces.data ?? []).map((entry) => ({
                  value: entry.name,
                  // A namespace that is going away can still hold actors, so it is
                  // offered — with its condition said out loud rather than left for
                  // the reader to wonder about when the tables come back empty.
                  label:
                    entry.status === "Active"
                      ? entry.name
                      : `${entry.name} (${entry.status.toLowerCase()})`,
                })),
              ]}
            />
          </div>
        </Space>

        {namespaces.error ? (
          <Alert
            type="error"
            showIcon
            title="Could not load the list of namespaces"
            description={`${namespaces.error.message} You can still name a namespace in this page's address.`}
            data-testid="substrate-namespaces-error"
            action={
              <Button size="small" onClick={() => void namespaces.refresh()}>
                Try again
              </Button>
            }
          />
        ) : null}

        {summary.error ? (
          <Alert
            type="error"
            showIcon
            title="Substrate inventory could not be read"
            description={summary.error.message}
            data-testid="substrate-inventory-error"
            action={
              <Button size="small" onClick={() => void summary.refresh()}>
                Try again
              </Button>
            }
          />
        ) : inventory?.ateApiError ? (
          /* A warning beside the data rather than an error instead of it. The read
             succeeded and the Kubernetes-derived halves are complete; only the runtime
             ones may be short. Flattening this into the error above would tell an
             operator their substrate was broken when part of it answered fine. */
          <Alert
            type="warning"
            showIcon
            title="Runtime actor state is incomplete"
            description={`Worker pools and actor templates come from Kubernetes and are complete. The actors and workers below come from ate-api, which answered with an error: ${inventory.ateApiError}`}
            data-testid="substrate-partial"
          />
        ) : null}

        <div
          css={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: theme.space(4),
          }}
        >
          <StatTile
            label="Worker pools"
            testId="substrate-stat-pools"
            value={inventory?.workerPools.length}
            isLoading={summary.isLoading}
            hint={unread}
          />
          {/* Both halves of each ratio, because the useful question is never the count
              on its own: three templates is good news or bad depending on how many of
              them came up. */}
          <StatTile
            label="Templates ready"
            testId="substrate-stat-templates"
            value={
              inventory
                ? `${readyTemplates}/${inventory.actorTemplates.length}`
                : undefined
            }
            isLoading={summary.isLoading}
            hint={unread}
          />
          <StatTile
            label="Actors running"
            testId="substrate-stat-actors"
            value={
              inventory
                ? `${inventory.runningActorCount.toLocaleString()}/${inventory.actorCount.toLocaleString()}`
                : undefined
            }
            isLoading={summary.isLoading}
            hint={unread}
          />
          <StatTile
            label="Workers busy"
            testId="substrate-stat-workers"
            value={
              inventory
                ? `${inventory.busyWorkerCount.toLocaleString()}/${inventory.workerCount.toLocaleString()}`
                : undefined
            }
            isLoading={summary.isLoading}
            hint={unread}
          />
          <StatTile
            label="ate-api"
            testId="substrate-stat-ateapi"
            value={inventory ? (ateApiEnabled ? "connected" : "off") : undefined}
            isLoading={summary.isLoading}
            hint={unread}
          />
          <StatTile
            label="Scope"
            testId="substrate-stat-scope"
            // Not read from the response — it is what this page asked for, which is
            // known even when the read failed, and is the thing that explains an empty
            // table.
            value={namespace === ALL_NAMESPACES ? "all" : namespace}
          />
        </div>

        {/* Every actor status, not only the running tally.
            Knowing that 1 of 410,110 actors is running says nothing about the other
            410,109 — and on this cluster what it does not say is that most of them
            have crashed. The summary counts them all, so the page can. */}
        {inventory && inventory.actorStatusCounts.length > 1 ? (
          <Space size={6} wrap data-testid="substrate-actor-status-counts">
            <Text css={{ ...muted, fontSize: 12 }}>Actors by status</Text>
            {inventory.actorStatusCounts.map((entry) => (
              <Tag key={entry.status} css={mono}>
                {entry.status || "not reported"}: {entry.count.toLocaleString()}
              </Tag>
            ))}
          </Space>
        ) : null}

        <Card
          title={
            <SectionTitle
              title="Worker pools"
              count={pools.length}
              total={inventory?.workerPools.length ?? 0}
            />
          }
          extra={
            <Space size={8}>
              <SectionHint>Kubernetes WorkerPool resources</SectionHint>
              <SectionSearch
                label="Search worker pools"
                testId="substrate-pools-search"
                value={poolQuery}
                onChange={setPoolQuery}
              />
            </Space>
          }
          data-testid="substrate-pools-card"
        >
          <Table<SubstrateWorkerPoolEntry>
            data-testid="substrate-pools-table"
            rowKey={(pool) => `${pool.namespace}/${pool.name}`}
            columns={workerPoolColumns}
            dataSource={pools}
            loading={summary.isLoading}
            pagination={false}
            size="small"
            locale={{
              emptyText: poolQuery.trim()
                ? "No worker pools match your search."
                : "No worker pools in this scope. Create one in the cluster, or install one with the Helm chart.",
            }}
          />
        </Card>

        <Card
          title={
            <SectionTitle
              title="Actor templates"
              count={templates.length}
              total={inventory?.actorTemplates.length ?? 0}
            />
          }
          extra={
            <Space size={8}>
              <SectionHint>Golden snapshots and harness-owned templates</SectionHint>
              <SectionSearch
                label="Search actor templates"
                testId="substrate-templates-search"
                value={templateQuery}
                onChange={setTemplateQuery}
              />
            </Space>
          }
          data-testid="substrate-templates-card"
        >
          <Table<SubstrateActorTemplateEntry>
            data-testid="substrate-templates-table"
            rowKey={(template) => `${template.namespace}/${template.name}`}
            columns={actorTemplateColumns}
            dataSource={templates}
            loading={summary.isLoading}
            pagination={false}
            size="small"
            locale={{
              emptyText: templateQuery.trim()
                ? "No actor templates match your search."
                : "No actor templates yet. One appears when you create a harness and an agent template.",
            }}
          />
        </Card>

        <Card
          title={
            <PagedSectionTitle
              title="Actors"
              shown={actorRows.length}
              onPage={actorPageRows.length}
              total={inventory?.actorCount}
              searching={Boolean(actorQuery.trim())}
            />
          }
          extra={
            <Space size={8}>
              <SectionHint>Live state from ate-api, one page at a time</SectionHint>
              <SectionSearch
                label="Search actors"
                testId="substrate-actors-search"
                value={actorQuery}
                onChange={setActorQuery}
              />
            </Space>
          }
          data-testid="substrate-actors-card"
        >
          {actors.error ? (
            <Alert
              type="error"
              showIcon
              title="Actors could not be read"
              description={actors.error.message}
              data-testid="substrate-actors-error"
              action={
                <Button size="small" onClick={() => void actors.refresh()}>
                  Try again
                </Button>
              }
            />
          ) : actors.data?.ateApiError ? (
            <PageWarning
              message={actors.data.ateApiError}
              testId="substrate-actors-partial"
            />
          ) : null}

          <Table<SubstrateActorEntry>
            data-testid="substrate-actors-table"
            rowKey={(actor) => actor.actorId}
            columns={actorColumns}
            dataSource={actorRows}
            loading={actors.isLoading}
            /* antd's own pager is off because the pages come from the server by token,
               not by number — `PageControls` below turns them. */
            pagination={false}
            virtual
            scroll={{ y: GROWING_TABLE_HEIGHT, x: 1040 }}
            size="small"
            /* Three different sentences, because they are three different facts and
               only one is something to act on: a controller with no ate-api endpoint
               is a deployment choice, a configured one reporting nothing means the
               actors really are not there, and a search that matched nothing is the
               reader's own doing. */
            locale={{
              emptyText: actors.error
                ? " "
                : actorQuery.trim()
                  ? "No actors on this page match your search. Other pages are not searched."
                  : ateApiEnabled
                    ? "ate-api reported no actors in this scope."
                    : "ate-api is not configured on this controller. Set substrate-ate-api-endpoint to see live actors.",
            }}
          />

          <PageScopeNote
            testId="substrate-actors-order"
            computedAt={actors.data?.computedAt}
          />

          <PageControls
            testId="substrate-actors-pages"
            page={actorPage}
            hasNext={Boolean(actors.data?.nextPageToken)}
            onNext={() => actorPage.next(actors.data?.nextPageToken ?? "")}
            onBack={actorPage.back}
            isLoading={actors.isLoading}
          />
        </Card>

        <Card
          title={
            <PagedSectionTitle
              title="Workers"
              shown={workerRows.length}
              onPage={workerPageRows.length}
              total={inventory?.workerCount}
              searching={Boolean(workerQuery.trim())}
            />
          }
          extra={
            <Space size={8}>
              <SectionHint>ateom pod assignments</SectionHint>
              <SectionSearch
                label="Search workers"
                testId="substrate-workers-search"
                value={workerQuery}
                onChange={setWorkerQuery}
              />
            </Space>
          }
          data-testid="substrate-workers-card"
        >
          {workers.error ? (
            <Alert
              type="error"
              showIcon
              title="Workers could not be read"
              description={workers.error.message}
              data-testid="substrate-workers-error"
              action={
                <Button size="small" onClick={() => void workers.refresh()}>
                  Try again
                </Button>
              }
            />
          ) : workers.data?.ateApiError ? (
            <PageWarning
              message={workers.data.ateApiError}
              testId="substrate-workers-partial"
            />
          ) : null}

          <Table<SubstrateWorkerEntry>
            data-testid="substrate-workers-table"
            rowKey={(worker) =>
              `${worker.workerNamespace}/${worker.workerPool}/${worker.workerPod}`
            }
            columns={workerColumns}
            dataSource={workerRows}
            loading={workers.isLoading}
            pagination={false}
            virtual
            scroll={{ y: GROWING_TABLE_HEIGHT, x: 880 }}
            size="small"
            locale={{
              emptyText: workers.error
                ? " "
                : workerQuery.trim()
                  ? "No workers on this page match your search. Other pages are not searched."
                  : ateApiEnabled
                    ? "ate-api reported no worker assignments."
                    : "Worker assignments come from ate-api, which is not configured on this controller.",
            }}
          />

          <PageScopeNote
            testId="substrate-workers-order"
            computedAt={workers.data?.computedAt}
          />

          <PageControls
            testId="substrate-workers-pages"
            page={workerPage}
            hasNext={Boolean(workers.data?.nextPageToken)}
            onNext={() => workerPage.next(workers.data?.nextPageToken ?? "")}
            onBack={workerPage.back}
            isLoading={workers.isLoading}
          />
        </Card>
      </Space>
    </PageFrame>
  );
}
