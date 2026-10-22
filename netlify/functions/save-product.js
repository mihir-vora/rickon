const crypto = require("crypto");

const MAX_IMAGE_BYTES = 1800000;

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "product";
}

function productSlug(name) {
  return slugify(name) + "-" + crypto.randomBytes(2).toString("hex");
}

function cleanBase64(value) {
  return String(value || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
}

function sniffImage(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.length > 12 && buffer.slice(0, 4).toString() === "RIFF" && buffer.slice(8, 12).toString() === "WEBP") return "webp";
  return "";
}

function paragraphs(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const parts = raw.includes("\n\n") ? raw.split(/\n\s*\n/) : raw.split(/\n/);
  return parts.map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40);
}

function lines(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  return raw.split(/\n/).map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40);
}

function specifications(list) {
  const seen = new Set();
  const rows = [];
  for (const row of Array.isArray(list) ? list : []) {
    const label = String(row && row.label || "").trim().slice(0, 160);
    const value = String(row && row.value || "").trim().slice(0, 400);
    const key = label.toLowerCase();
    if (!label || !value || seen.has(key)) continue;
    seen.add(key);
    rows.push({ label, value });
  }
  return rows;
}

function videoUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{6,})/);
  const id = match ? match[1] : (/^[\w-]{6,}$/.test(raw) ? raw : "");
  if (!id) {
    const error = new Error("Paste a YouTube link for the product video.");
    error.statusCode = 400;
    throw error;
  }
  return "https://www.youtube.com/watch?v=" + id;
}

function imageNumber(src) {
  const match = String(src || "").match(/\/(\d+)\.[a-z0-9]+$/i);
  return match ? Number(match[1]) : 0;
}

function imagesFromPayload(payload, slug) {
  const incoming = Array.isArray(payload.images) ? payload.images : [];
  const start = Number(payload.startIndex);
  const startIndex = Number.isInteger(start) && start >= 0 ? start : 0;
  if (!incoming.length) {
    const error = new Error("Add at least one photo.");
    error.statusCode = 400;
    throw error;
  }
  return incoming.map((image, index) => {
    const encoded = cleanBase64(image && image.data);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      const error = new Error("One of the photos could not be read. Choose the photo again.");
      error.statusCode = 400;
      throw error;
    }
    const buffer = Buffer.from(encoded, "base64");
    const ext = sniffImage(buffer);
    if (!ext) {
      const error = new Error("Photos must be JPG, PNG, or WebP.");
      error.statusCode = 400;
      throw error;
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error("One photo is too large. Use a smaller photo.");
      error.statusCode = 400;
      throw error;
    }
    const path = `images/${slug}/${startIndex + index + 1}.${ext}`;
    return {
      path,
      content: buffer.toString("base64"),
      record: { src: "/" + path, large: "/" + path, primary: startIndex + index === 0 }
    };
  });
}

function buildProduct(payload, slug, imageRecords) {
  const name = String(payload.name || "").trim().slice(0, 140);
  const title = String(payload.fullTitle || payload.full_title || "").trim().slice(0, 200);
  const price = Math.round(Number(payload.price));
  if (name.length < 2) {
    const error = new Error("Enter the product name.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(price) || price < 0 || price > 100000000) {
    const error = new Error("Enter the price in rupees.");
    error.statusCode = 400;
    throw error;
  }
  const product = {
    id: slug,
    slug,
    name,
    full_title: title || name,
    listing_status: "listed on category page",
    price: { amount: price, currency: "INR", unit: "Piece" },
    images: imageRecords,
    video: videoUrl(payload.video),
    description: paragraphs(payload.description),
    specifications: specifications(payload.specifications),
    product_details: specifications(payload.productDetails || payload.product_details)
  };
  const features = lines(payload.features);
  const applications = lines(payload.applications);
  const benefits = lines(payload.benefits);
  if (features.length) product.features = features;
  if (applications.length) product.applications = applications;
  if (benefits.length) product.benefits = benefits;
  return product;
}

function resolveCategory(catalog, payload) {
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const requestedId = String(payload.categoryId || "").trim();
  const requestedName = String(payload.categoryName || "").trim().slice(0, 80);
  if (requestedId && requestedId !== "__new") {
    const found = categories.find(category => category.id === requestedId);
    if (!found || !/^[\w.-]+$/.test(found.file || "")) {
      const error = new Error("Choose a category from the list.");
      error.statusCode = 400;
      throw error;
    }
    return { id: found.id, name: found.name, file: found.file, isNew: false };
  }
  if (requestedName.length < 2) {
    const error = new Error("Choose a category, or type a new category name.");
    error.statusCode = 400;
    throw error;
  }
  const id = slugify(requestedName);
  if (id === "catalog") {
    const error = new Error("Choose a different category name.");
    error.statusCode = 400;
    throw error;
  }
  const existing = categories.find(category => category.id === id || String(category.name || "").toLowerCase() === requestedName.toLowerCase());
  if (existing) return { id: existing.id, name: existing.name, file: existing.file, isNew: false };
  return { id, name: requestedName, file: id + ".json", isNew: true };
}

function uniqueSlug(name, products) {
  const taken = new Set((products || []).map(product => product.slug));
  let slug = productSlug(name);
  while (taken.has(slug)) slug = productSlug(name);
  return slug;
}

function applyProduct(file, category, product) {
  const next = file || { category: { id: category.id, name: category.name, image: "" }, products: [] };
  if (!next.category) next.category = { id: category.id, name: category.name, image: "" };
  if (!Array.isArray(next.products)) next.products = [];
  next.category.id = next.category.id || category.id;
  next.category.name = next.category.name || category.name;
  if (!next.category.image && product.images[0]) next.category.image = product.images[0].large;
  next.products.push(product);
  if ("extracted_count" in next.category) next.category.extracted_count = next.products.length;
  return next;
}

function assertSlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    const error = new Error("The product was not found. Refresh the page and choose it again.");
    error.statusCode = 400;
    throw error;
  }
  return slug;
}

function findCategory(catalog, id) {
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const found = categories.find(category => category.id === id);
  if (!found || !/^[\w.-]+$/.test(found.file || "")) {
    const error = new Error("Choose a category from the list.");
    error.statusCode = 400;
    throw error;
  }
  return { id: found.id, name: found.name, file: found.file, isNew: false };
}

function allowedImageRef(value, slug) {
  if (value.startsWith("https://5.imimg.com/") && value.length < 500 && !/[\s"'<>]/.test(value)) return true;
  return value.startsWith("/images/" + slug + "/") && /^\/images\/[a-z0-9-]+\/[\w.-]+$/i.test(value);
}

function imageRecordsFromSlots(payload, slug) {
  if (!Array.isArray(payload.imageSlots)) {
    const error = new Error("The photos could not be read. Refresh the page and try again.");
    error.statusCode = 400;
    throw error;
  }
  const incoming = Array.isArray(payload.images) ? payload.images : [];
  const start = Number(payload.startIndex);
  const startIndex = Number.isInteger(start) && start >= 0 ? start : 0;
  const records = [];
  const uploads = [];
  let uploadAt = 0;
  payload.imageSlots.forEach(slot => {
    if (slot && slot.src) {
      const src = String(slot.src);
      const large = String(slot.large || src);
      if (!allowedImageRef(src, slug) || !allowedImageRef(large, slug)) {
        const error = new Error("One of the saved photos could not be kept. Refresh the page and try again.");
        error.statusCode = 400;
        throw error;
      }
      records.push({ src, large, primary: false });
      return;
    }
    if (slot && slot.upload) {
      const stored = imagesFromPayload({ images: [incoming[uploadAt]], startIndex: startIndex + uploadAt }, slug);
      uploadAt += 1;
      records.push(stored[0].record);
      uploads.push({ path: stored[0].path, content: stored[0].content });
      return;
    }
    const error = new Error("One of the photos could not be read. Choose the photo again.");
    error.statusCode = 400;
    throw error;
  });
  if (uploadAt !== incoming.length) {
    const error = new Error("One of the photos could not be read. Choose the photo again.");
    error.statusCode = 400;
    throw error;
  }
  records.forEach((record, index) => { record.primary = index === 0; });
  return { records, uploads };
}

function mergeProduct(existing, payload, imageRecords) {
  const fresh = buildProduct(payload, existing.slug, imageRecords);
  const next = { ...existing, ...fresh, id: existing.id || fresh.id, slug: existing.slug };
  if (!fresh.features) delete next.features;
  if (!fresh.applications) delete next.applications;
  if (!fresh.benefits) delete next.benefits;
  if (existing.price && existing.price.unit) next.price = { ...next.price, unit: existing.price.unit };
  return next;
}

function placeProduct(file, category, product) {
  const next = file || { category: { id: category.id, name: category.name, image: "" }, products: [] };
  if (!next.category) next.category = { id: category.id, name: category.name, image: "" };
  if (!Array.isArray(next.products)) next.products = [];
  next.category.id = next.category.id || category.id;
  next.category.name = next.category.name || category.name;
  const index = next.products.findIndex(item => item.slug === product.slug);
  if (index >= 0) next.products[index] = product;
  else next.products.push(product);
  if (!next.category.image && product.images[0]) next.category.image = product.images[0].large;
  if ("extracted_count" in next.category) next.category.extracted_count = next.products.length;
  return next;
}

function removeProduct(file, slug) {
  if (!file || !Array.isArray(file.products)) {
    const error = new Error("The product was not found. Refresh the page and choose it again.");
    error.statusCode = 400;
    throw error;
  }
  const index = file.products.findIndex(item => item.slug === slug);
  if (index < 0) {
    const error = new Error("The product was not found. Refresh the page and choose it again.");
    error.statusCode = 400;
    throw error;
  }
  const [product] = file.products.splice(index, 1);
  if (file.category && "extracted_count" in file.category) file.category.extracted_count = file.products.length;
  return product;
}

function jsonFile(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8").toString("base64");
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

async function github(token, path, options = {}) {
  const res = await fetch("https://api.github.com" + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "rickon-admin",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { message: text.slice(0, 180) }; }
  }
  if (!res.ok) {
    const error = new Error(body && body.message ? body.message : "GitHub could not save the product.");
    error.status = res.status;
    if (res.status === 422 && /fast forward|cannot be updated|Reference/i.test(error.message)) error.retry = true;
    throw error;
  }
  return body;
}

async function readRepoJson(token, repo, branch, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const meta = await github(token, `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
  let encodedContent = meta.content || "";
  if (!encodedContent && meta.sha) {
    const blob = await github(token, `/repos/${repo}/git/blobs/${meta.sha}`);
    encodedContent = blob.content || "";
  }
  return JSON.parse(Buffer.from(encodedContent, "base64").toString("utf8"));
}

async function commitFiles(token, repo, branch, files, message) {
  const ref = await github(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parentSha = ref.object.sha;
  const parent = await github(token, `/repos/${repo}/git/commits/${parentSha}`);
  const blobs = [];
  for (const file of files) {
    if (file.deleted) {
      blobs.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await github(token, `/repos/${repo}/git/blobs`, {
      method: "POST",
      body: { content: file.content, encoding: "base64" }
    });
    blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await github(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: parent.tree.sha, tree: blobs }
  });
  const commit = await github(token, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [parentSha] }
  });
  await github(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: { sha: commit.sha }
  });
  return commit.sha;
}

async function updateOnce(payload, token, repo, branch) {
  const slug = assertSlug(String(payload.slug || ""));
  const catalog = await readRepoJson(token, repo, branch, "data/catalog.json");
  const source = findCategory(catalog, String(payload.sourceCategoryId || ""));
  const current = await readRepoJson(token, repo, branch, "data/" + source.file);
  const existing = current && Array.isArray(current.products) ? current.products.find(item => item.slug === slug) : null;
  if (!existing) {
    const error = new Error("The product was not found. Refresh the page and choose it again.");
    error.statusCode = 400;
    throw error;
  }
  if (payload.stage) {
    const storedImages = imagesFromPayload(payload, slug);
    await commitFiles(token, repo, branch, storedImages.map(image => ({ path: image.path, content: image.content })), `Add photos to: ${existing.name}\n\nSaved from the Rickon admin page.`);
    return { name: existing.name, category: source.name, categoryId: source.id, slug, imageCount: storedImages.length, staged: true };
  }
  const destination = resolveCategory(catalog, payload);
  const { records, uploads } = imageRecordsFromSlots(payload, slug);
  const product = mergeProduct(existing, payload, records);
  const files = [...uploads.map(image => ({ path: image.path, content: image.content }))];
  if (source.id === destination.id) {
    files.push({ path: "data/" + source.file, content: jsonFile(placeProduct(current, source, product)) });
  } else {
    removeProduct(current, slug);
    files.push({ path: "data/" + source.file, content: jsonFile(current) });
    let destinationFile = null;
    try {
      destinationFile = await readRepoJson(token, repo, branch, "data/" + destination.file);
    } catch (error) {
      if (!destination.isNew || error.status !== 404) throw error;
    }
    if (destinationFile && Array.isArray(destinationFile.products) && destinationFile.products.some(item => item.slug === slug)) {
      const error = new Error("That category already has this product.");
      error.statusCode = 400;
      throw error;
    }
    files.push({ path: "data/" + destination.file, content: jsonFile(placeProduct(destinationFile, destination, product)) });
    if (destination.isNew) {
      catalog.categories = catalog.categories || [];
      catalog.categories.push({ id: destination.id, name: destination.name, file: destination.file });
      files.push({ path: "data/catalog.json", content: jsonFile(catalog) });
    }
  }
  await commitFiles(token, repo, branch, files, `Update product: ${product.name}\n\nSaved from the Rickon admin page.`);
  return { name: product.name, category: destination.name, categoryId: destination.id, slug, imageCount: product.images.length, images: product.images };
}

async function deleteOnce(payload, token, repo, branch) {
  const slug = assertSlug(String(payload.slug || ""));
  const catalog = await readRepoJson(token, repo, branch, "data/catalog.json");
  const category = findCategory(catalog, String(payload.categoryId || ""));
  const current = await readRepoJson(token, repo, branch, "data/" + category.file);
  const product = removeProduct(current, slug);
  const categoryRemoved = current.products.length === 0;
  const files = [];
  if (categoryRemoved) {
    catalog.categories = (catalog.categories || []).filter(item => item.id !== category.id);
    files.push({ path: "data/catalog.json", content: jsonFile(catalog) });
    files.push({ path: "data/" + category.file, deleted: true });
  } else {
    files.push({ path: "data/" + category.file, content: jsonFile(current) });
  }
  await commitFiles(token, repo, branch, files, `Remove product: ${product.name}\n\nSaved from the Rickon admin page.`);
  return { name: product.name, category: category.name, categoryId: category.id, slug, deleted: true, categoryRemoved };
}

async function deleteCategoryOnce(payload, token, repo, branch) {
  const catalog = await readRepoJson(token, repo, branch, "data/catalog.json");
  const category = findCategory(catalog, String(payload.categoryId || ""));
  let missing = false;
  try {
    await readRepoJson(token, repo, branch, "data/" + category.file);
  } catch (error) {
    if (error.status !== 404) throw error;
    missing = true;
  }
  catalog.categories = (catalog.categories || []).filter(item => item.id !== category.id);
  const files = [{ path: "data/catalog.json", content: jsonFile(catalog) }];
  if (!missing) files.push({ path: "data/" + category.file, deleted: true });
  await commitFiles(token, repo, branch, files, `Remove category: ${category.name}\n\nSaved from the Rickon admin page.`);
  return { category: category.name, categoryId: category.id, deletedCategory: true };
}

async function saveOnce(payload, token, repo, branch) {
  if (payload.action === "update") return updateOnce(payload, token, repo, branch);
  if (payload.action === "delete") return deleteOnce(payload, token, repo, branch);
  if (payload.action === "delete-category") return deleteCategoryOnce(payload, token, repo, branch);
  const catalog = await readRepoJson(token, repo, branch, "data/catalog.json");
  const category = resolveCategory(catalog, payload);
  let current = null;
  try {
    current = await readRepoJson(token, repo, branch, "data/" + category.file);
  } catch (error) {
    if (!category.isNew || error.status !== 404) throw error;
  }
  if (payload.append) {
    const slug = String(payload.slug || "");
    const product = current && Array.isArray(current.products) ? current.products.find(item => item.slug === slug) : null;
    if (!product || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      const error = new Error("The product was not found. Save it again.");
      error.statusCode = 400;
      throw error;
    }
    const storedImages = imagesFromPayload(payload, slug);
    if (!Array.isArray(product.images)) product.images = [];
    storedImages.forEach(image => {
      if (!product.images.some(existing => existing.src === image.record.src)) product.images.push(image.record);
    });
    product.images.sort((a, b) => imageNumber(a.src) - imageNumber(b.src));
    product.images.forEach((image, index) => { image.primary = index === 0; });
    await commitFiles(token, repo, branch, [
      { path: "data/" + category.file, content: jsonFile(current) },
      ...storedImages.map(image => ({ path: image.path, content: image.content }))
    ], `Add photos to: ${product.name}\n\nSaved from the Rickon admin page.`);
    return { name: product.name, category: category.name, categoryId: category.id, slug, imageCount: product.images.length };
  }

  const products = current && Array.isArray(current.products) ? current.products : [];
  const slug = uniqueSlug(payload.name, products);
  const storedImages = imagesFromPayload(payload, slug);
  const product = buildProduct(payload, slug, storedImages.map(image => image.record));
  const nextFile = applyProduct(current, category, product);
  const files = [
    { path: "data/" + category.file, content: jsonFile(nextFile) },
    ...storedImages.map(image => ({ path: image.path, content: image.content }))
  ];
  if (category.isNew) {
    catalog.categories = catalog.categories || [];
    catalog.categories.push({ id: category.id, name: category.name, file: category.file });
    files.push({ path: "data/catalog.json", content: jsonFile(catalog) });
  }
  await commitFiles(token, repo, branch, files, `Add product: ${product.name}\n\nSaved from the Rickon admin page.`);
  return { name: product.name, category: category.name, categoryId: category.id, slug: product.slug, imageCount: product.images.length };
}

async function handler(event) {
  if (event.httpMethod === "OPTIONS") return response(204, {});
  if (event.httpMethod !== "POST") return response(405, { error: "Use the admin form to save a product." });

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "mihir-vora/rickon";
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!token) {
    return response(503, { error: "The admin save is not set up on Netlify yet. Add GITHUB_TOKEN." });
  }

  let payload;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
    payload = JSON.parse(raw || "{}");
  } catch {
    return response(400, { error: "The form could not be read. Try again." });
  }
  try {
    let saved;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        saved = await saveOnce(payload, token, repo, branch);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!error.retry || attempt === 1) break;
      }
    }
    if (lastError) throw lastError;
    return response(200, { ok: true, ...saved });
  } catch (error) {
    const statusCode = error.statusCode || (error.status === 401 || error.status === 403 ? 502 : 500);
    let message = error.statusCode ? error.message : "The product could not be saved. Try again in a moment.";
    if (payload && payload.action === "delete" && !error.statusCode) message = "The product could not be deleted. Try again in a moment.";
    if (payload && payload.action === "delete-category" && !error.statusCode) message = "The category could not be deleted. Try again in a moment.";
    if (error.status === 401 || error.status === 403) message = "GitHub refused the save. Check the GITHUB_TOKEN in Netlify.";
    if (error.status === 404) message = "GitHub could not find the repository or the catalogue file.";
    return response(statusCode, { error: message });
  }
}

module.exports = {
  handler,
  slugify,
  buildProduct,
  resolveCategory,
  applyProduct,
  mergeProduct,
  placeProduct,
  removeProduct,
  imageRecordsFromSlots,
  imagesFromPayload,
  paragraphs,
  specifications,
  videoUrl,
  lines
};
