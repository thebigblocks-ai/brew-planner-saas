const crypto = require("crypto");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const BUCKET = process.env.YC_STORAGE_BUCKET;
const PREFIX = (process.env.YC_STORAGE_PREFIX || "brew-planner").replace(/^\/+|\/+$/g, "");
const ENDPOINT = process.env.YC_STORAGE_ENDPOINT || "https://storage.yandexcloud.net";
const REGION = process.env.YC_STORAGE_REGION || "ru-central1";
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 24 * 14);
const PASSWORD_ITERATIONS = 120000;
const ROLES = new Set(["admin", "manager", "reader"]);
const ORGANIZATION_ROLES = new Set(["org_admin", "editor", "reader"]);

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.YC_SECRET_ACCESS_KEY || ""
  }
});

function key(name) {
  return `${PREFIX}/${name}`;
}

const PLAN_KEY = key("plan.json");
const USERS_KEY = key("users.json");
const LOGS_KEY = key("action-logs.json");
const PRESENCE_KEY = key("presence.json");
const ORGANIZATIONS_KEY = key("organizations.json");
const MEMBERSHIPS_KEY = key("memberships.json");
const TICKETS_KEY = key("support-tickets.json");
const DEFAULT_ORGANIZATION_ID = "default";

function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Max-Age": "86400",
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function textResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Max-Age": "86400",
      ...headers
    },
    body
  };
}

function parseEvent(event) {
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const method = String(event.httpMethod || event.requestContext?.http?.method || "GET").toUpperCase();
  const rawPath = event.path || event.rawPath || "/";
  const path = String(rawPath).replace(/^\/api(?=\/|$)/, "") || "/";
  let body = {};
  if (event.body) {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    body = rawBody ? JSON.parse(rawBody) : {};
  }
  return { method, path, headers, body };
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMissingObjectError(error) {
  return error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

async function readJson(objectKey, fallback) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey }));
    return JSON.parse(await streamToString(result.Body));
  } catch (error) {
    if (isMissingObjectError(error)) return fallback;
    throw error;
  }
}

async function writeJson(objectKey, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json; charset=utf-8"
  }));
}

function assertConfig() {
  const missing = [];
  if (!BUCKET) missing.push("YC_STORAGE_BUCKET");
  if (!process.env.YC_ACCESS_KEY_ID) missing.push("YC_ACCESS_KEY_ID");
  if (!process.env.YC_SECRET_ACCESS_KEY) missing.push("YC_SECRET_ACCESS_KEY");
  if (!JWT_SECRET) missing.push("JWT_SECRET");
  if (!ADMIN_EMAIL) missing.push("ADMIN_EMAIL");
  if (!ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function base64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function signToken(user) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    role: user.role,
    serviceRole: user.serviceRole || "user",
    organizationId: user.organizationId || "",
    organizationRole: user.organizationRole || legacyRoleToOrganizationRole(user.role),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const [header, payload, signature] = String(token || "").split(".");
  if (!header || !payload || !signature) throw new Error("Invalid token");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid token");
  }
  const data = JSON.parse(fromBase64url(payload));
  if (Number(data.exp || 0) < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return data;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, iterations, salt, hash] = String(storedHash || "").split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterations || !salt || !hash) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, "sha256").toString("hex");
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(hash, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function legacyRoleToOrganizationRole(role) {
  if (role === "admin") return "org_admin";
  if (role === "manager") return "editor";
  return "reader";
}

function organizationRoleToLegacyRole(role) {
  if (role === "org_admin") return "admin";
  if (role === "editor") return "manager";
  return "reader";
}

function defaultOrganization() {
  return {
    id: DEFAULT_ORGANIZATION_ID,
    name: process.env.DEFAULT_ORGANIZATION_NAME || "Default Organization",
    slug: process.env.DEFAULT_ORGANIZATION_SLUG || "default",
    status: "active",
    tariff: "manual",
    logoDataUrl: "",
    logoName: "",
    features: {},
    createdAt: new Date().toISOString()
  };
}

async function loadOrganizations() {
  let organizations = await readJson(ORGANIZATIONS_KEY, null);
  if (Array.isArray(organizations) && organizations.length) return organizations;
  organizations = [defaultOrganization()];
  await writeJson(ORGANIZATIONS_KEY, organizations);
  return organizations;
}

async function saveOrganizations(organizations) {
  await writeJson(ORGANIZATIONS_KEY, organizations);
}

async function loadMemberships(users, organizations) {
  let memberships = await readJson(MEMBERSHIPS_KEY, null);
  if (Array.isArray(memberships) && memberships.length) return memberships;
  const organizationId = organizations[0]?.id || DEFAULT_ORGANIZATION_ID;
  memberships = users.map((user) => ({
    id: crypto.randomUUID(),
    organizationId,
    userId: user.id,
    role: legacyRoleToOrganizationRole(user.role),
    createdAt: new Date().toISOString()
  }));
  await writeJson(MEMBERSHIPS_KEY, memberships);
  return memberships;
}

async function saveMemberships(memberships) {
  await writeJson(MEMBERSHIPS_KEY, memberships);
}

function organizationPlanKey(organizationId) {
  return key(`orgs/${organizationId}/plan.json`);
}

function organizationLogsKey(organizationId) {
  return key(`orgs/${organizationId}/action-logs.json`);
}

function organizationPresenceKey(organizationId) {
  return key(`orgs/${organizationId}/presence.json`);
}

function organizationFromMembership(organizations, membership) {
  return organizations.find((organization) => organization.id === membership?.organizationId) || null;
}

function buildAuthUser(user, membership, organizations) {
  const organization = organizationFromMembership(organizations, membership);
  const organizationRole = membership?.role || legacyRoleToOrganizationRole(user.role);
  return {
    ...user,
    serviceRole: user.serviceRole || "user",
    organizationId: membership?.organizationId || organization?.id || DEFAULT_ORGANIZATION_ID,
    organizationRole,
    organizationName: organization?.name || "",
    organizationLogoDataUrl: organization?.logoDataUrl || "",
    organizationLogoName: organization?.logoName || "",
    role: organizationRoleToLegacyRole(organizationRole)
  };
}

function publicUser(user, context = {}) {
  return {
    id: user.id,
    email: user.email,
    login: user.email,
    displayName: user.displayName || "",
    department: user.department || "",
    phone: user.phone || "",
    comment: user.comment || "",
    role: user.role || "reader",
    organizationRole: user.organizationRole || legacyRoleToOrganizationRole(user.role),
    organizationId: user.organizationId || context.organizationId || "",
    organizationName: user.organizationName || context.organizationName || "",
    organizationLogoDataUrl: user.organizationLogoDataUrl || context.organizationLogoDataUrl || "",
    organizationLogoName: user.organizationLogoName || context.organizationLogoName || "",
    serviceRole: user.serviceRole || "user",
    organizations: Array.isArray(context.organizations) ? context.organizations : undefined,
    createdAt: user.createdAt || ""
  };
}

function createUser({ email, password, displayName = "", role = "reader" }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail.includes("@")) throw new Error("Email is required");
  if (!String(password || "").trim()) throw new Error("Password is required");
  if (!ROLES.has(role)) throw new Error("Invalid role");
  return {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    displayName: String(displayName || "").trim(),
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };
}

async function loadUsers() {
  let users = await readJson(USERS_KEY, null);
  if (Array.isArray(users) && users.length) {
    const normalizedAdminEmail = normalizeEmail(ADMIN_EMAIL);
    const normalized = users.map((user) => ({
      ...user,
      serviceRole: user.serviceRole || (normalizeEmail(user.email) === normalizedAdminEmail ? "super_admin" : "user")
    }));
    if (JSON.stringify(normalized) !== JSON.stringify(users)) await writeJson(USERS_KEY, normalized);
    return normalized;
  }
  const admin = createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    displayName: process.env.ADMIN_DISPLAY_NAME || "Administrator",
    role: "admin"
  });
  admin.serviceRole = "super_admin";
  users = [admin];
  await writeJson(USERS_KEY, users);
  return users;
}

async function saveUsers(users) {
  await writeJson(USERS_KEY, users);
}

function extractBearer(headers) {
  const value = headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function requireUser(req) {
  const token = extractBearer(req.headers);
  if (!token) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  const payload = verifyToken(token);
  const users = await loadUsers();
  const user = users.find((item) => item.id === payload.sub);
  if (!user) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  const organizations = await loadOrganizations();
  const memberships = await loadMemberships(users, organizations);
  const activeMembership = memberships.find((item) => item.userId === user.id && item.organizationId === payload.organizationId)
    || memberships.find((item) => item.userId === user.id);
  if (!activeMembership && user.serviceRole !== "super_admin") {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  const activeOrganization = organizationFromMembership(organizations, activeMembership);
  if (activeOrganization?.status === "blocked" && user.serviceRole !== "super_admin") {
    throw Object.assign(new Error("Organization is blocked"), { statusCode: 403 });
  }
  return {
    user: buildAuthUser(user, activeMembership, organizations),
    users,
    organizations,
    memberships,
    activeMembership
  };
}

function requireEditor(user) {
  if (user.serviceRole === "super_admin" || user.organizationRole === "org_admin" || user.organizationRole === "editor") return;
  if (user.role === "admin" || user.role === "manager") return;
  throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

function requireAdmin(user) {
  if (user.serviceRole === "super_admin" || user.organizationRole === "org_admin") return;
  if (user.role === "admin") return;
  throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

function requireSuperAdmin(user) {
  if (user.serviceRole === "super_admin") return;
  throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

function emptyPlan() {
  return {
    sites: [],
    tanks: [],
    cycles: [],
    productTemplates: [],
    features: {},
    revision: 0,
    updatedAt: null
  };
}

function normalizePlan(input) {
  const source = input?.plan && typeof input.plan === "object" ? input.plan : input;
  return {
    sites: Array.isArray(source?.sites) ? source.sites : [],
    tanks: Array.isArray(source?.tanks) ? source.tanks : [],
    cycles: Array.isArray(source?.cycles) ? source.cycles : [],
    productTemplates: Array.isArray(source?.productTemplates) ? source.productTemplates : [],
    features: source?.features && typeof source.features === "object" ? source.features : {}
  };
}

function pruneLogs(logs) {
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => Date.parse(log.createdAt || "") >= cutoff)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 1000);
}

async function handleLogin(req) {
  const email = normalizeEmail(req.body.email || req.body.login);
  const password = req.body.password || "";
  const users = await loadUsers();
  const user = users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return jsonResponse(401, { message: "Invalid login or password" });
  }
  const organizations = await loadOrganizations();
  const memberships = await loadMemberships(users, organizations);
  const userMemberships = memberships.filter((item) => item.userId === user.id);
  const activeMembership = userMemberships[0];
  const authUser = buildAuthUser(user, activeMembership, organizations);
  const organizationOptions = userMemberships.map((membership) => {
    const organization = organizationFromMembership(organizations, membership);
    return {
      id: membership.organizationId,
      name: organization?.name || "",
      slug: organization?.slug || "",
      role: membership.role
    };
  });
  return jsonResponse(200, {
    user: publicUser(authUser, { organizations: organizationOptions }),
    token: signToken(authUser)
  });
}

async function handleUsers(req, auth) {
  const segments = req.path.split("/").filter(Boolean);
  if (req.method === "GET" && segments.length === 1) {
    const organizationMemberships = auth.memberships.filter((membership) => membership.organizationId === auth.user.organizationId);
    const users = organizationMemberships
      .map((membership) => {
        const user = auth.users.find((item) => item.id === membership.userId);
        return user ? publicUser(buildAuthUser(user, membership, auth.organizations)) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.email.localeCompare(b.email));
    return jsonResponse(200, { users });
  }
  requireAdmin(auth.user);
  if (req.method === "POST" && segments.length === 1) {
    const email = normalizeEmail(req.body.email || req.body.login);
    let nextUser = auth.users.find((user) => user.email === email);
    let users = auth.users;
    if (!nextUser) {
      nextUser = createUser({
      email: req.body.email || req.body.login,
      password: req.body.password,
      displayName: req.body.displayName,
      role: req.body.role || "reader"
      });
      users = auth.users.concat(nextUser);
      await saveUsers(users);
    } else if (auth.memberships.some((membership) => membership.userId === nextUser.id && membership.organizationId === auth.user.organizationId)) {
      return jsonResponse(409, { message: "User already exists" });
    }
    const role = legacyRoleToOrganizationRole(req.body.role || nextUser.role || "reader");
    const membership = {
      id: crypto.randomUUID(),
      organizationId: auth.user.organizationId,
      userId: nextUser.id,
      role,
      createdAt: new Date().toISOString()
    };
    const memberships = auth.memberships.concat(membership);
    await saveMemberships(memberships);
    return jsonResponse(201, { user: publicUser(buildAuthUser(nextUser, membership, auth.organizations)) });
  }
  const id = segments[1];
  const target = auth.users.find((user) => user.id === id || user.email === normalizeEmail(id));
  if (!target) return jsonResponse(404, { message: "User not found" });
  const targetMembership = auth.memberships.find((membership) => membership.userId === target.id && membership.organizationId === auth.user.organizationId);
  if (!targetMembership) return jsonResponse(404, { message: "User not found" });
  if (req.method === "PATCH" && segments.length === 2) {
    const legacyRole = req.body.role || organizationRoleToLegacyRole(targetMembership.role);
    if (!ROLES.has(legacyRole)) return jsonResponse(400, { message: "Invalid role" });
    const organizationRole = legacyRoleToOrganizationRole(legacyRole);
    const users = auth.users.map((user) => user.id === target.id ? {
      ...user,
      displayName: req.body.displayName !== undefined ? String(req.body.displayName || "").trim() : user.displayName,
      department: req.body.department !== undefined ? String(req.body.department || "").trim() : user.department,
      phone: req.body.phone !== undefined ? String(req.body.phone || "").trim() : user.phone,
      comment: req.body.comment !== undefined ? String(req.body.comment || "").trim() : user.comment
    } : user);
    const memberships = auth.memberships.map((membership) => membership.id === targetMembership.id ? {
      ...membership,
      role: organizationRole,
      updatedAt: new Date().toISOString()
    } : membership);
    await saveUsers(users);
    await saveMemberships(memberships);
    return jsonResponse(200, {
      user: publicUser(buildAuthUser(users.find((user) => user.id === target.id), memberships.find((membership) => membership.id === targetMembership.id), auth.organizations))
    });
  }
  if ((req.method === "PATCH" || req.method === "POST") && segments.length === 3 && segments[2] === "password") {
    const password = String(req.body.password || "");
    if (password.trim().length < 4) {
      return jsonResponse(400, { message: "Password must contain at least 4 characters" });
    }
    const users = auth.users.map((user) => user.id === target.id ? {
      ...user,
      passwordHash: hashPassword(password)
    } : user);
    await saveUsers(users);
    return jsonResponse(200, { user: publicUser(users.find((user) => user.id === target.id)) });
  }
  if (req.method === "DELETE" && segments.length === 2) {
    if (target.id === auth.user.id) return jsonResponse(400, { message: "Current user cannot be deleted" });
    await saveMemberships(auth.memberships.filter((membership) => membership.id !== targetMembership.id));
    return jsonResponse(200, { ok: true });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

async function handlePlan(req, auth) {
  const planKey = organizationPlanKey(auth.user.organizationId);
  if (req.method === "GET") {
    const legacyPlan = await readJson(PLAN_KEY, emptyPlan());
    const plan = await readJson(planKey, legacyPlan);
    return jsonResponse(200, { plan });
  }
  if (req.method === "PUT" || req.method === "POST") {
    requireEditor(auth.user);
    const legacyPlan = await readJson(PLAN_KEY, emptyPlan());
    const currentPlan = await readJson(planKey, legacyPlan);
    const nextPlan = {
      ...normalizePlan(req.body),
      organizationId: auth.user.organizationId,
      revision: Number(currentPlan.revision || 0) + 1,
      updatedAt: new Date().toISOString()
    };
    await writeJson(planKey, nextPlan);
    return jsonResponse(200, { plan: nextPlan });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

async function handleLogs(req, auth) {
  const logsKey = organizationLogsKey(auth.user.organizationId);
  if (req.method === "GET") {
    const legacyLogs = await readJson(LOGS_KEY, []);
    const logs = pruneLogs(await readJson(logsKey, legacyLogs));
    if (logs.length) await writeJson(logsKey, logs);
    return jsonResponse(200, { logs: logs.slice(0, 300) });
  }
  if (req.method === "POST") {
    const logs = pruneLogs(await readJson(logsKey, []));
    const log = {
      id: req.body.id || crypto.randomUUID(),
      createdAt: req.body.createdAt || new Date().toISOString(),
      userId: auth.user.id,
      userName: auth.user.displayName || auth.user.email,
      userEmail: auth.user.email,
      organizationId: auth.user.organizationId,
      action: String(req.body.action || ""),
      entityType: String(req.body.entityType || ""),
      entityId: String(req.body.entityId || ""),
      title: String(req.body.title || ""),
      details: req.body.details && typeof req.body.details === "object" ? req.body.details : {}
    };
    await writeJson(logsKey, pruneLogs([log].concat(logs)));
    return jsonResponse(201, { log });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

function activePresence(presence) {
  const cutoff = Date.now() - 90 * 1000;
  return Object.values(presence || {})
    .filter((user) => Date.parse(user.lastSeen || "") >= cutoff)
    .sort((a, b) => String(a.displayName || a.email).localeCompare(String(b.displayName || b.email), "ru"));
}

function publicOrganization(organization, memberships = [], users = []) {
  const orgMemberships = memberships.filter((membership) => membership.organizationId === organization.id);
  const userIds = new Set(orgMemberships.map((membership) => membership.userId));
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status || "active",
    tariff: organization.tariff || "manual",
    logoDataUrl: organization.logoDataUrl || "",
    logoName: organization.logoName || "",
    features: organization.features && typeof organization.features === "object" ? organization.features : {},
    userCount: users.filter((user) => userIds.has(user.id)).length,
    createdAt: organization.createdAt || "",
    updatedAt: organization.updatedAt || ""
  };
}

function organizationSlug(name) {
  return String(name || "organization")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `org-${Date.now()}`;
}

function uniqueOrganizationSlug(organizations, baseSlug) {
  let slug = baseSlug;
  let index = 2;
  while (organizations.some((organization) => organization.slug === slug)) {
    slug = `${baseSlug}-${index}`;
    index += 1;
  }
  return slug;
}

function defaultOrganizationFeatures() {
  return {
    partialBottlings: true,
    warehouseCalendar: true,
    bottlings: true,
    comments: true,
    productTemplates: true,
    cycleSources: true,
    actionLog: true,
    filters: true,
    bulkActions: true,
    onlineUsers: true,
    supportTickets: true,
    cycleTasks: false,
    cycleProcess: true,
    contractBrews: false,
    contractBrewery: true
  };
}

async function handleOrganizations(req, auth) {
  requireSuperAdmin(auth.user);
  const segments = req.path.split("/").filter(Boolean);
  if (req.method === "GET" && segments.length === 1) {
    const organizations = auth.organizations
      .map((organization) => publicOrganization(organization, auth.memberships, auth.users))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return jsonResponse(200, { organizations });
  }
  if (req.method === "POST" && segments.length === 1) {
    const name = String(req.body.name || "").trim();
    if (!name) return jsonResponse(400, { message: "Organization name is required" });
    const baseSlug = organizationSlug(req.body.slug || name);
    const organization = {
      id: crypto.randomUUID(),
      name,
      slug: uniqueOrganizationSlug(auth.organizations, baseSlug),
      status: req.body.status || "trial",
      tariff: req.body.tariff || "manual",
      logoDataUrl: "",
      logoName: "",
      features: { ...defaultOrganizationFeatures(), ...(req.body.features || {}) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const organizations = auth.organizations.concat(organization);
    await saveOrganizations(organizations);
    await writeJson(organizationPlanKey(organization.id), {
      ...emptyPlan(),
      organizationId: organization.id,
      features: organization.features,
      updatedAt: new Date().toISOString()
    });
    return jsonResponse(201, { organization: publicOrganization(organization, auth.memberships, auth.users) });
  }
  const organizationId = segments[1];
  const organization = auth.organizations.find((item) => item.id === organizationId || item.slug === organizationId);
  if (!organization) return jsonResponse(404, { message: "Organization not found" });
  if (req.method === "GET" && segments.length === 2) {
    return jsonResponse(200, { organization: publicOrganization(organization, auth.memberships, auth.users) });
  }
  if (req.method === "PATCH" && segments.length === 2) {
    const organizations = auth.organizations.map((item) => item.id === organization.id ? {
      ...item,
      name: req.body.name !== undefined ? String(req.body.name || "").trim() || item.name : item.name,
      status: req.body.status || item.status,
      tariff: req.body.tariff || item.tariff,
      logoDataUrl: req.body.logoDataUrl !== undefined ? String(req.body.logoDataUrl || "") : item.logoDataUrl,
      logoName: req.body.logoName !== undefined ? String(req.body.logoName || "") : item.logoName,
      updatedAt: new Date().toISOString()
    } : item);
    await saveOrganizations(organizations);
    return jsonResponse(200, {
      organization: publicOrganization(organizations.find((item) => item.id === organization.id), auth.memberships, auth.users)
    });
  }
  if (segments.length === 3 && segments[2] === "features") {
    if (req.method === "GET") {
      return jsonResponse(200, { features: organization.features || {} });
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const features = { ...defaultOrganizationFeatures(), ...(organization.features || {}), ...(req.body.features || req.body || {}) };
      const organizations = auth.organizations.map((item) => item.id === organization.id ? {
        ...item,
        features,
        updatedAt: new Date().toISOString()
      } : item);
      await saveOrganizations(organizations);
      const plan = await readJson(organizationPlanKey(organization.id), emptyPlan());
      await writeJson(organizationPlanKey(organization.id), { ...plan, organizationId: organization.id, features });
      return jsonResponse(200, { features });
    }
  }
  if (segments.length >= 3 && segments[2] === "users") {
    return handleOrganizationUsers(req, auth, organization, segments.slice(3));
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

async function handleOrganizationUsers(req, auth, organization, tailSegments) {
  if (req.method === "GET" && tailSegments.length === 0) {
    const organizationMemberships = auth.memberships.filter((membership) => membership.organizationId === organization.id);
    const users = organizationMemberships
      .map((membership) => {
        const user = auth.users.find((item) => item.id === membership.userId);
        return user ? publicUser(buildAuthUser(user, membership, auth.organizations)) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.email.localeCompare(b.email));
    return jsonResponse(200, { users });
  }
  if (req.method === "POST" && tailSegments.length === 0) {
    const email = normalizeEmail(req.body.email || req.body.login);
    let user = auth.users.find((item) => item.email === email);
    let users = auth.users;
    if (!user) {
      user = createUser({
        email,
        password: req.body.password,
        displayName: req.body.displayName,
        role: organizationRoleToLegacyRole(req.body.organizationRole || legacyRoleToOrganizationRole(req.body.role || "reader"))
      });
      users = users.concat(user);
      await saveUsers(users);
    }
    if (auth.memberships.some((membership) => membership.organizationId === organization.id && membership.userId === user.id)) {
      return jsonResponse(409, { message: "User already exists in organization" });
    }
    const organizationRole = req.body.organizationRole || legacyRoleToOrganizationRole(req.body.role || "reader");
    if (!ORGANIZATION_ROLES.has(organizationRole)) return jsonResponse(400, { message: "Invalid organization role" });
    const membership = {
      id: crypto.randomUUID(),
      organizationId: organization.id,
      userId: user.id,
      role: organizationRole,
      createdAt: new Date().toISOString()
    };
    const memberships = auth.memberships.concat(membership);
    await saveMemberships(memberships);
    return jsonResponse(201, { user: publicUser(buildAuthUser(user, membership, auth.organizations)) });
  }
  const userId = tailSegments[0];
  const user = auth.users.find((item) => item.id === userId || item.email === normalizeEmail(userId));
  if (!user) return jsonResponse(404, { message: "User not found" });
  const membership = auth.memberships.find((item) => item.organizationId === organization.id && item.userId === user.id);
  if (!membership) return jsonResponse(404, { message: "User not found in organization" });
  if (req.method === "PATCH" && tailSegments.length === 1) {
    const organizationRole = req.body.organizationRole || legacyRoleToOrganizationRole(req.body.role || organizationRoleToLegacyRole(membership.role));
    if (!ORGANIZATION_ROLES.has(organizationRole)) return jsonResponse(400, { message: "Invalid organization role" });
    const users = auth.users.map((item) => item.id === user.id ? {
      ...item,
      displayName: req.body.displayName !== undefined ? String(req.body.displayName || "").trim() : item.displayName,
      department: req.body.department !== undefined ? String(req.body.department || "").trim() : item.department,
      phone: req.body.phone !== undefined ? String(req.body.phone || "").trim() : item.phone,
      comment: req.body.comment !== undefined ? String(req.body.comment || "").trim() : item.comment
    } : item);
    const memberships = auth.memberships.map((item) => item.id === membership.id ? {
      ...item,
      role: organizationRole,
      updatedAt: new Date().toISOString()
    } : item);
    await saveUsers(users);
    await saveMemberships(memberships);
    return jsonResponse(200, {
      user: publicUser(buildAuthUser(users.find((item) => item.id === user.id), memberships.find((item) => item.id === membership.id), auth.organizations))
    });
  }
  if (req.method === "DELETE" && tailSegments.length === 1) {
    await saveMemberships(auth.memberships.filter((item) => item.id !== membership.id));
    return jsonResponse(200, { ok: true });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

function nextTicketNumber(tickets) {
  const year = new Date().getFullYear();
  const prefix = `BP-${year}-`;
  const max = (Array.isArray(tickets) ? tickets : []).reduce((result, ticket) => {
    const number = String(ticket.number || "");
    if (!number.startsWith(prefix)) return result;
    const value = Number(number.slice(prefix.length));
    return Number.isFinite(value) ? Math.max(result, value) : result;
  }, 0);
  return `${prefix}${String(max + 1).padStart(6, "0")}`;
}

async function handleTickets(req, auth) {
  const segments = req.path.split("/").filter(Boolean);
  const tickets = await readJson(TICKETS_KEY, []);
  const visibleTickets = auth.user.serviceRole === "super_admin"
    ? tickets
    : tickets.filter((ticket) => ticket.organizationId === auth.user.organizationId);
  if (req.method === "GET" && segments.length === 1) {
    return jsonResponse(200, {
      tickets: visibleTickets.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    });
  }
  if (req.method === "POST" && segments.length === 1) {
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    if (!title || !description) return jsonResponse(400, { message: "Title and description are required" });
    const ticket = {
      id: crypto.randomUUID(),
      number: nextTicketNumber(tickets),
      organizationId: auth.user.organizationId,
      organizationName: auth.user.organizationName || "",
      createdByUserId: auth.user.id,
      createdByName: auth.user.displayName || auth.user.email,
      createdByEmail: auth.user.email,
      category: String(req.body.category || "other"),
      title,
      description,
      status: "new",
      priority: String(req.body.priority || "normal"),
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 5) : [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await writeJson(TICKETS_KEY, [ticket].concat(tickets));
    return jsonResponse(201, { ticket });
  }
  const ticketId = segments[1];
  const ticket = tickets.find((item) => item.id === ticketId || item.number === ticketId);
  if (!ticket || (auth.user.serviceRole !== "super_admin" && ticket.organizationId !== auth.user.organizationId)) {
    return jsonResponse(404, { message: "Ticket not found" });
  }
  if (req.method === "PATCH" && segments.length === 2) {
    if (auth.user.serviceRole !== "super_admin" && req.body.status && req.body.status !== ticket.status) {
      return jsonResponse(403, { message: "Only support can change ticket status" });
    }
    const ticketsNext = tickets.map((item) => item.id === ticket.id ? {
      ...item,
      status: req.body.status || item.status,
      category: req.body.category || item.category,
      priority: req.body.priority || item.priority,
      updatedAt: new Date().toISOString()
    } : item);
    await writeJson(TICKETS_KEY, ticketsNext);
    return jsonResponse(200, { ticket: ticketsNext.find((item) => item.id === ticket.id) });
  }
  if (req.method === "POST" && segments.length === 3 && segments[2] === "messages") {
    const text = String(req.body.text || "").trim();
    if (!text) return jsonResponse(400, { message: "Message is required" });
    const message = {
      id: crypto.randomUUID(),
      authorUserId: auth.user.id,
      authorName: auth.user.displayName || auth.user.email,
      authorEmail: auth.user.email,
      isInternal: Boolean(req.body.isInternal) && auth.user.serviceRole === "super_admin",
      text,
      createdAt: new Date().toISOString()
    };
    const ticketsNext = tickets.map((item) => item.id === ticket.id ? {
      ...item,
      messages: (Array.isArray(item.messages) ? item.messages : []).concat(message),
      updatedAt: new Date().toISOString()
    } : item);
    await writeJson(TICKETS_KEY, ticketsNext);
    return jsonResponse(201, { message });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

async function handlePresence(req, auth) {
  const presenceKey = organizationPresenceKey(auth.user.organizationId);
  const presence = await readJson(presenceKey, {});
  if (req.method === "POST") {
    presence[auth.user.id] = {
      id: auth.user.id,
      login: auth.user.email,
      email: auth.user.email,
      displayName: auth.user.displayName || "",
      role: auth.user.role,
      organizationId: auth.user.organizationId,
      lastSeen: new Date().toISOString()
    };
    await writeJson(presenceKey, presence);
  }
  if (req.method === "GET" || req.method === "POST") {
    return jsonResponse(200, { users: activePresence(presence) });
  }
  return jsonResponse(405, { message: "Method not allowed" });
}

async function route(req) {
  assertConfig();
  if (req.method === "OPTIONS") return textResponse(204, "");
  if (req.path === "/" || req.path === "/health") {
    return jsonResponse(200, { ok: true, service: "brew-planner-yandex-api" });
  }
  if (req.path === "/auth/login" && req.method === "POST") return handleLogin(req);
  const auth = await requireUser(req);
  if (req.path === "/auth/me" && req.method === "GET") {
    const organizationOptions = auth.memberships
      .filter((membership) => membership.userId === auth.user.id)
      .map((membership) => {
        const organization = organizationFromMembership(auth.organizations, membership);
        return {
          id: membership.organizationId,
          name: organization?.name || "",
          slug: organization?.slug || "",
          role: membership.role
        };
      });
    return jsonResponse(200, { user: publicUser(auth.user, { organizations: organizationOptions }) });
  }
  if (req.path === "/plan") return handlePlan(req, auth);
  if (req.path === "/logs") return handleLogs(req, auth);
  if (req.path === "/presence") return handlePresence(req, auth);
  if (req.path === "/organizations" || req.path.startsWith("/organizations/")) return handleOrganizations(req, auth);
  if (req.path === "/tickets" || req.path.startsWith("/tickets/")) return handleTickets(req, auth);
  if (req.path === "/users" || req.path.startsWith("/users/")) return handleUsers(req, auth);
  return jsonResponse(404, { message: "Not found" });
}

module.exports.handler = async function handler(event) {
  try {
    return await route(parseEvent(event || {}));
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { message: error.message || "Internal error" });
  }
};
