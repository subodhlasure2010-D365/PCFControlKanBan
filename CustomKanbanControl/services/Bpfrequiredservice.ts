import { getClientUrl } from "./MetadataService";

/** Missing required fields for one BPF stage. */
export interface MissingStageFields {
    stage: string; // stage display name (e.g. "Develop")
    fields: string[]; // display names of the empty required fields
}

export interface RequiredFieldCheck {
    ok: boolean;
    missing: MissingStageFields[];
    recordUrl: string;
}

/** A BPF table and the lookup on it that points back at the kanban's record. */
interface BpfCandidate {
    logicalName: string;
    /** OData lookup property, e.g. "_bpf_opportunityid_value". */
    lookup: string;
}

// ---------------------------------------------------------------------------
// Session caches (cleared on full page refresh)
// ---------------------------------------------------------------------------

/** recordId -> processId of its active BPF ("" = looked up, none found). */
const processByRecord = new Map<string, string>();

/** processId -> map of normalized stage name -> required attribute logical names. */
const stageRequirementsByProcess = new Map<string, Map<string, string[]>>();

/** entityName -> map of attribute logical name -> display name. */
const attributeNamesByEntity = new Map<string, Map<string, string>>();

/**
 * Checks whether the record can leave the given BPF stages, i.e. whether
 * every field marked "Business required" on those stages has a value.
 *
 * `stageNames` should contain every stage the card is moving OUT of when
 * it is dropped: for a single-step move that is just the source stage; for
 * a jump of 2+ columns it is every stage from the source up to (but not
 * including) the target.
 *
 * Written fail-open: any unexpected failure (BPF missing, metadata
 * unavailable, clientdata unparsable) returns ok:true so a technical
 * problem never wrongly blocks a legitimate move.
 */
export async function checkBpfRequiredFields(
    context: ComponentFramework.Context<unknown>,
    entityName: string,
    recordId: string,
    stageNames: string[]
): Promise<RequiredFieldCheck> {
    const cleanId = recordId.replace(/[{}]/g, "");
    const base = getClientUrl(context);
    const recordUrl = buildRecordUrl(base, entityName, cleanId);
    const failOpen: RequiredFieldCheck = { ok: true, missing: [], recordUrl };

    if (stageNames.length === 0) {
        log("no stages to check — allowing move");
        return failOpen;
    }

    try {
        log("checking stages:", stageNames, "record:", cleanId);

        // 1) Which BPF is this record running?
        const processId = await findActiveProcessId(context, entityName, cleanId);
        if (!processId) {
            log("NO BPF INSTANCE FOUND for this record — allowing move. " +
                "No activated BPF instance was found for this record.");
            return failOpen;
        }
        log("BPF process id:", processId);

        // 2) Required attributes per stage (from each stage's own clientdata).
        const stageMap = await getStageRequirements(context, processId, entityName);
        log("stage requirements map:", Array.from(stageMap.entries()));
        const perStage: { stage: string; attrs: string[] }[] = [];
        const allAttrs = new Set<string>();
        for (const stage of stageNames) {
            const attrs = stageMap.get(normalize(stage)) ?? [];
            if (attrs.length > 0) {
                perStage.push({ stage, attrs });
                attrs.forEach((a) => allAttrs.add(a));
            }
        }
        if (allAttrs.size === 0) {
            log("no required attributes found for", stageNames, "— allowing move. " +
                "Either the stage names don't match or clientdata had no required steps.");
            return failOpen;
        }

        // 3) Validate the attributes against entity metadata and resolve
        //    display names. Unknown attributes are dropped so a bad
        //    clientdata parse can never produce an invalid $select.
        const displayNames = await getAttributeDisplayNames(context, entityName);
        const validAttrs = Array.from(allAttrs).filter((a) => displayNames.has(a));
        if (validAttrs.length === 0) {
            log("attribute metadata lookup returned nothing — allowing move");
            return failOpen;
        }
        log("validating fields:", validAttrs);

        // 4) Read the record and find the empty required fields.
        //    IMPORTANT: read with a cache-bypassing fetch. UCI caches
        //    context.webAPI.retrieveRecord responses client-side, so after
        //    the user fills the field and saves, the cached (stale) copy
        //    would still report it empty and wrongly keep blocking.
        let record: Record<string, unknown>;
        try {
            record = await fetchRecordFresh(context, entityName, cleanId);
        } catch (e) {
            log("fresh fetch failed, falling back to webAPI:",
                (e as { message?: string })?.message ?? e);
            record = (await context.webAPI.retrieveRecord(
                entityName,
                cleanId,
                `?$select=${validAttrs.join(",")}`
            )) as unknown as Record<string, unknown>;
        }

        const isEmpty = (attr: string): boolean => {
            const raw = record[attr];
            const lookupVal = record[`_${attr}_value`];
            return (
                (raw === null || raw === undefined || raw === "") &&
                (lookupVal === null || lookupVal === undefined || lookupVal === "")
            );
        };

        // Log what the check actually saw — instant diagnosis if wrong.
        const seen: Record<string, unknown> = {};
        for (const a of validAttrs) {
            seen[a] = record[a] ?? record[`_${a}_value`] ?? null;
        }
        log("record values:", seen);

        const missing: MissingStageFields[] = [];
        for (const entry of perStage) {
            const emptyFields = entry.attrs
                .filter((a) => displayNames.has(a) && isEmpty(a))
                .map((a) => displayNames.get(a) as string);
            if (emptyFields.length > 0) {
                missing.push({ stage: entry.stage, fields: emptyFields });
            }
        }

        log("missing fields:", missing);
        return { ok: missing.length === 0, missing, recordUrl };
    } catch (e) {
        // Never block on an unexpected failure.
        // eslint-disable-next-line no-console
        console.warn("[Kanban BPF] check failed unexpectedly; allowing move.", e);
        return failOpen;
    }
}

/** Diagnostic logging — check the browser console when a move isn't blocked. */
function log(...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.info("[Kanban BPF]", ...args);
}

// ---------------------------------------------------------------------------
// Step 1: active process lookup
// ---------------------------------------------------------------------------

/** entityName -> BPF tables found for it (cached per session). */
const bpfCandidatesByEntity = new Map<string, BpfCandidate[]>();

/**
 * Finds every activated BPF whose primary entity is `entityName` and the
 * lookup each BPF table uses to point at the record. Works for custom BPFs
 * ("bpf_<entity>id") and out-of-box ones ("<entity>id") alike.
 */
async function getBpfCandidates(
    context: ComponentFramework.Context<unknown>,
    entityName: string
): Promise<BpfCandidate[]> {
    const cached = bpfCandidatesByEntity.get(entityName);
    if (cached) {
        return cached;
    }
    const candidates: BpfCandidate[] = [];
    try {
        // category 4 = Business Process Flow, type 1 = definition, statecode 1 = activated
        const res = await context.webAPI.retrieveMultipleRecords(
            "workflow",
            `?$select=uniquename&$filter=category eq 4 and type eq 1 and statecode eq 1 and primaryentity eq '${entityName}'`
        );
        for (const wf of res.entities) {
            const bpfTable = ((wf.uniquename as string) ?? "").toLowerCase();
            if (!bpfTable) {
                continue;
            }
            const lookup = await findLookupTo(context, bpfTable, entityName);
            if (lookup) {
                candidates.push({ logicalName: bpfTable, lookup: `_${lookup}_value` });
            }
        }
    } catch (e) {
        log("BPF discovery failed:", (e as { message?: string })?.message ?? e);
    }
    log("BPF candidates for", entityName, candidates);
    bpfCandidatesByEntity.set(entityName, candidates);
    return candidates;
}

/** Logical name of the lookup on `fromEntity` that references `toEntity`. */
async function findLookupTo(
    context: ComponentFramework.Context<unknown>,
    fromEntity: string,
    toEntity: string
): Promise<string | null> {
    try {
        const url =
            `${getClientUrl(context)}/api/data/v9.2/EntityDefinitions(LogicalName='${fromEntity}')` +
            `/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity` +
            `&$filter=ReferencedEntity eq '${toEntity}'`;
        const res = await fetch(url, {
            headers: { Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
            credentials: "same-origin",
        });
        if (!res.ok) {
            return null;
        }
        const json = (await res.json()) as { value?: { ReferencingAttribute: string }[] };
        return json.value?.[0]?.ReferencingAttribute ?? null;
    } catch {
        return null;
    }
}

async function findActiveProcessId(
    context: ComponentFramework.Context<unknown>,
    entityName: string,
    recordId: string
): Promise<string | null> {
    if (processByRecord.has(recordId)) {
        const cached = processByRecord.get(recordId) as string;
        return cached === "" ? null : cached;
    }
    const candidates = await getBpfCandidates(context, entityName);
    for (const candidate of candidates) {
        const filters = [
            `${candidate.lookup} eq ${recordId} and statecode eq 0`,
            `${candidate.lookup} eq ${recordId}`, // retry without state filter
        ];
        for (const filter of filters) {
            try {
                const res = await context.webAPI.retrieveMultipleRecords(
                    candidate.logicalName,
                    `?$select=_processid_value&$filter=${filter}&$top=1`
                );
                if (res.entities.length > 0) {
                    const processId = (res.entities[0]._processid_value as string) ?? "";
                    if (processId) {
                        processByRecord.set(recordId, processId);
                        return processId;
                    }
                }
                log(candidate.logicalName, "query OK but 0 instances (filter:", filter + ")");
                break;
            } catch (e) {
                log(candidate.logicalName, "query failed (filter:", filter + "):",
                    (e as { message?: string })?.message ?? e);
            }
        }
    }
    processByRecord.set(recordId, "");
    return null;
}

// ---------------------------------------------------------------------------
// Step 2: per-stage required attributes from processstage.clientdata
// ---------------------------------------------------------------------------

/**
 * Loads every stage of the process once and parses each stage's own
 * clientdata JSON, which contains only that stage's steps — no guessing
 * which part of the workflow-level blob belongs to which stage.
 */
async function getStageRequirements(
    context: ComponentFramework.Context<unknown>,
    processId: string,
    entityName: string
): Promise<Map<string, string[]>> {
    const cached = stageRequirementsByProcess.get(processId);
    if (cached) {
        return cached;
    }

    const map = new Map<string, string[]>();
    const res = await context.webAPI.retrieveMultipleRecords(
        "processstage",
        `?$select=processstageid,stagename,clientdata,primaryentitytypecode&$filter=_processid_value eq ${processId}`
    );

    const stageIdToName = new Map<string, string>();
    const stageRecords: { name: string; clientData: string }[] = [];

    for (const stage of res.entities) {
        const stageName = (stage.stagename as string) ?? "";
        const stageId = ((stage.processstageid as string) ?? "").replace(/[{}]/g, "").toLowerCase();
        const stageEntity = (stage.primaryentitytypecode as string) ?? "";
        // Cross-entity BPFs: only stages on the kanban's entity apply here.
        if (stageEntity && stageEntity.toLowerCase() !== entityName.toLowerCase()) {
            continue;
        }
        if (!stageName) {
            continue;
        }
        if (stageId) {
            stageIdToName.set(stageId, stageName);
        }
        stageRecords.push({ name: stageName, clientData: (stage.clientdata as string) ?? "" });
        map.set(normalize(stageName), []);
    }

    // PRIMARY: workflow-level clientdata, scoped per stage via stageId.
    // (Stage-level clientdata is unreliable: in many orgs it lists steps
    // with empty AttributeName and without stage scoping.)
    let anyFound = false;
    if (stageIdToName.size > 0) {
        try {
            const wf = await context.webAPI.retrieveRecord(
                "workflow",
                processId,
                "?$select=clientdata"
            );
            const wfData = (wf.clientdata as string) ?? "";
            if (wfData) {
                const perStage = new Map<string, Set<string>>();
                collectRequiredByStage(JSON.parse(wfData), stageIdToName, null, perStage);
                for (const [stageName, attrs] of perStage.entries()) {
                    if (attrs.size > 0) {
                        anyFound = true;
                        map.set(normalize(stageName), Array.from(attrs));
                    }
                }
            }
        } catch (e) {
            log("workflow.clientdata parse failed:",
                (e as { message?: string })?.message ?? e);
        }
    }

    // FALLBACK: per-stage clientdata (works only when the required flag
    // and attribute name sit on the same node and names are populated).
    if (!anyFound) {
        log("workflow.clientdata yielded nothing — trying per-stage clientdata");
        for (const stage of stageRecords) {
            if (!stage.clientData) {
                continue;
            }
            const attrs = new Set<string>();
            try {
                collectRequired(JSON.parse(stage.clientData), attrs);
            } catch {
                const re =
                    /"(?:controlDataFieldName|dataFieldName)"\s*:\s*"([a-z0-9_]+)"[^{}]*?"isProcessRequired"\s*:\s*true/gi;
                let m: RegExpExecArray | null;
                while ((m = re.exec(stage.clientData)) !== null) {
                    attrs.add(m[1].toLowerCase());
                }
            }
            if (attrs.size > 0) {
                map.set(normalize(stage.name), Array.from(attrs));
            }
        }
    }

    stageRequirementsByProcess.set(processId, map);
    return map;
}

/**
 * Walks the workflow-level clientdata. Whenever a node carries a stageId
 * matching a known stage, everything nested beneath it is attributed to
 * that stage. A step is required when the flag sits on the node itself OR
 * on a parent (real orgs put isProcessRequired on the StepStep while the
 * dataFieldName sits on the nested ControlStep), so when a required node
 * is found, field names are harvested from its entire subtree.
 */
function collectRequiredByStage(
    node: unknown,
    stageIdToName: Map<string, string>,
    currentStage: string | null,
    out: Map<string, Set<string>>
): void {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            collectRequiredByStage(item, stageIdToName, currentStage, out);
        }
        return;
    }
    const obj = node as Record<string, unknown>;

    let stage = currentStage;
    for (const key of ["stageId", "stageid", "StageId"]) {
        const v = obj[key];
        if (typeof v === "string" && v !== "") {
            const clean = v.replace(/[{}]/g, "").toLowerCase();
            const name = stageIdToName.get(clean);
            if (name) {
                stage = name;
            }
            break;
        }
    }

    // Required flag on THIS node → harvest field names from its subtree.
    if (stage && isRequiredFlagSet(obj)) {
        const fields = new Set<string>();
        collectFieldNamesDeep(obj, fields);
        if (fields.size > 0) {
            let bucket = out.get(stage);
            if (!bucket) {
                bucket = new Set<string>();
                out.set(stage, bucket);
            }
            fields.forEach((a) => bucket?.add(a));
        }
    }

    for (const key of Object.keys(obj)) {
        collectRequiredByStage(obj[key], stageIdToName, stage, out);
    }
}

/** True when the node itself carries a truthy required flag (any casing). */
function isRequiredFlagSet(obj: Record<string, unknown>): boolean {
    let reqRaw: unknown;
    for (const key of Object.keys(obj)) {
        if (REQUIRED_KEYS.indexOf(key.toLowerCase()) !== -1) {
            reqRaw = obj[key];
            break;
        }
    }
    const reqStr = String(reqRaw ?? "").toLowerCase();
    return reqRaw === true || reqRaw === 2 || reqStr === "true" || reqStr === "required" || reqStr === "2";
}

/** Recursively harvests attribute logical names from a subtree (any casing). */
function collectFieldNamesDeep(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            collectFieldNamesDeep(item, out);
        }
        return;
    }
    const obj = node as Record<string, unknown>;
    let field = "";
    let controlId = "";
    for (const key of Object.keys(obj)) {
        const lk = key.toLowerCase();
        const v = obj[key];
        if (typeof v !== "string" || v === "") {
            continue;
        }
        if (FIELD_KEYS.indexOf(lk) !== -1 && field === "") {
            field = v;
        } else if (lk === "controlid" && /^[a-z][a-z0-9_]*$/i.test(v)) {
            controlId = v;
        }
    }
    if (field === "") {
        field = controlId;
    }
    if (field !== "") {
        out.add(field.toLowerCase());
    }
    for (const key of Object.keys(obj)) {
        collectFieldNamesDeep(obj[key], out);
    }
}

/** Required-step detection for a single node (no recursion). Key names in
 *  clientdata vary in casing across platform versions (camelCase vs
 *  PascalCase), so matching is done on lowercased keys. */
const FIELD_KEYS = ["controldatafieldname", "datafieldname", "attributename"];
const REQUIRED_KEYS = ["isprocessrequired", "isrequired", "requiredlevel", "required"];

function collectRequiredShallow(obj: Record<string, unknown>, out: Set<string>): void {
    // Build a lowercase-key view of the node.
    const lower: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        lower[key.toLowerCase()] = obj[key];
    }

    let field = "";
    for (const key of FIELD_KEYS) {
        const v = lower[key];
        if (typeof v === "string" && v !== "") {
            field = v;
            break;
        }
    }
    if (field === "") {
        const cid = lower["controlid"];
        if (typeof cid === "string" && /^[a-z][a-z0-9_]*$/i.test(cid)) {
            field = cid;
        }
    }

    let reqRaw: unknown;
    for (const key of REQUIRED_KEYS) {
        if (lower[key] !== undefined) {
            reqRaw = lower[key];
            break;
        }
    }
    const reqStr = String(reqRaw ?? "").toLowerCase();
    const isRequired = reqRaw === true || reqRaw === 2 || reqStr === "true" || reqStr === "required" || reqStr === "2";
    if (field !== "" && isRequired) {
        out.add(field.toLowerCase());
    }
}

/**
 * Recursively walks parsed stage clientdata collecting the logical names
 * of attributes whose step is marked process-required. Key names vary
 * across platform versions, so several candidates are checked.
 */
function collectRequired(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            collectRequired(item, out);
        }
        return;
    }
    const obj = node as Record<string, unknown>;
    collectRequiredShallow(obj, out);
    for (const key of Object.keys(obj)) {
        collectRequired(obj[key], out);
    }
}

// ---------------------------------------------------------------------------
// Step 3: attribute display names (also acts as attribute validation)
// ---------------------------------------------------------------------------

async function getAttributeDisplayNames(
    context: ComponentFramework.Context<unknown>,
    entityName: string
): Promise<Map<string, string>> {
    const cached = attributeNamesByEntity.get(entityName);
    if (cached) {
        return cached;
    }
    const map = new Map<string, string>();
    const base = getClientUrl(context);
    const url =
        `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')` +
        `/Attributes?$select=LogicalName,DisplayName`;
    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        },
        credentials: "same-origin",
    });
    if (res.ok) {
        const json = (await res.json()) as {
            value?: {
                LogicalName: string;
                DisplayName?: { UserLocalizedLabel?: { Label?: string } };
            }[];
        };
        for (const attr of json.value ?? []) {
            const logical = attr.LogicalName.toLowerCase();
            const label = attr.DisplayName?.UserLocalizedLabel?.Label ?? logical;
            map.set(logical, label);
        }
    }
    attributeNamesByEntity.set(entityName, map);
    return map;
}

// ---------------------------------------------------------------------------

/** entityName -> OData entity set name (e.g. opportunity -> opportunities). */
const entitySetByEntity = new Map<string, string>();

async function getEntitySetName(
    context: ComponentFramework.Context<unknown>,
    entityName: string
): Promise<string> {
    const cached = entitySetByEntity.get(entityName);
    if (cached) {
        return cached;
    }
    const base = getClientUrl(context);
    const res = await fetch(
        `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')?$select=EntitySetName`,
        {
            headers: {
                Accept: "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            },
            credentials: "same-origin",
        }
    );
    if (!res.ok) {
        throw new Error(`EntitySetName lookup failed: ${res.status}`);
    }
    const json = (await res.json()) as { EntitySetName?: string };
    if (!json.EntitySetName) {
        throw new Error("EntitySetName missing in metadata response");
    }
    entitySetByEntity.set(entityName, json.EntitySetName);
    return json.EntitySetName;
}

/**
 * Retrieves the record straight from the OData endpoint, bypassing the
 * UCI client cache (cache: no-store + no-cache headers). Fetches the
 * whole record (no $select) — raw OData rejects lookup logical names in
 * $select, and a single record payload is small anyway.
 */
async function fetchRecordFresh(
    context: ComponentFramework.Context<unknown>,
    entityName: string,
    recordId: string
): Promise<Record<string, unknown>> {
    const base = getClientUrl(context);
    const setName = await getEntitySetName(context, entityName);
    const res = await fetch(`${base}/api/data/v9.2/${setName}(${recordId})`, {
        headers: {
            Accept: "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
        },
        credentials: "same-origin",
        cache: "no-store",
    });
    if (!res.ok) {
        throw new Error(`record fetch failed: ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
}

function normalize(value: string): string {
    return value
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function buildRecordUrl(base: string, entityName: string, id: string): string {
    return `${base}/main.aspx?etn=${entityName}&id=${id}&pagetype=entityrecord`;
}