import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export function frameCount(seconds) {
    const value = seconds * 24;
    const floor = Math.floor(value);
    const rounded = value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
    const frames = Math.max(5, rounded);
    return frames + ((5 - frames % 17 + 17) % 17);
}

export function parseScenePlan(text, references) {
    const plan = JSON.parse(text);
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Scene plan must be a JSON object containing run_name, shared_prompt and scenes.");
    const run_name = plan.run_name ?? "MyFilm";
    const shared_prompt = plan.shared_prompt ?? "";
    if (typeof run_name !== "string" || typeof shared_prompt !== "string") throw new Error("run_name and shared_prompt must be text.");
    if (!Array.isArray(plan.scenes) || !plan.scenes.length) throw new Error("Add at least one scene to the scenes list.");
    const scenes = plan.scenes.map((scene, index) => {
        const label = `Scene ${index + 1}`;
        if (!scene || typeof scene !== "object" || Array.isArray(scene)) throw new Error(`${label} must be a JSON object.`);
        if (typeof scene.prompt !== "string" || !scene.prompt.trim()) throw new Error(`${label} needs a prompt.`);
        if (!Number.isFinite(scene.seconds) || scene.seconds <= 0) throw new Error(`${label} needs a positive seconds value.`);
        if (!Array.isArray(scene.references) || !scene.references.every(name => typeof name === "string" && references[name])) {
            throw new Error(`${label}: references must match Load Image titles, such as REF: enoch.`);
        }
        if (new Set(scene.references).size !== scene.references.length) throw new Error(`${label} lists a reference twice.`);
        if (scene.connect_previous !== undefined && typeof scene.connect_previous !== "boolean") {
            throw new Error(`${label}: connect_previous must be true or false.`);
        }
        if (index === 0 && scene.connect_previous) throw new Error("The first scene cannot connect to a previous scene.");
        if (scene.seed !== undefined && (!Number.isSafeInteger(scene.seed) || scene.seed < 0)) {
            throw new Error(`${label}: seed must be a nonnegative integer.`);
        }
        const seed = scene.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
        return { ...scene, seed, frames: frameCount(scene.seconds) };
    });
    return { run_name, shared_prompt, scenes };
}

function outputPath(file) {
    return [file.subfolder, file.filename].filter(Boolean).join("/");
}

export function scenePrompt(base, targets, references, scene, shared, previous, prefix) {
    const output = structuredClone(base);
    const conditioning = output[targets.conditioning];
    if (!conditioning || !output[targets.video] || !output[targets.last_frame]) {
        throw new Error("Scene Queue targets are missing. Reload the supplied scene workflow.");
    }
    for (const name of Object.keys(conditioning.inputs)) {
        if (/^ref_(images|videos|video_audios|audios)(\.|$)/.test(name)) delete conditioning.inputs[name];
    }
    const pictures = new Map();
    scene.references.forEach((name, index) => {
        conditioning.inputs[`ref_images.ref_image_${index}`] = [references[name], 0];
        pictures.set(name, `<Picture ${index + 1}>`);
    });
    let text = [shared, scene.prompt].filter(Boolean).join("\n\n");
    text = text.replace(/@([A-Za-z][A-Za-z0-9_-]*)/g, (_, name) => {
        if (!pictures.has(name)) throw new Error(`@${name} is used in the prompt but missing from this scene's references.`);
        return pictures.get(name);
    });
    text = [...pictures].map(([name, tag]) => `${tag} is the appearance reference for ${name}.`).join("\n") + "\n\n" + text;
    if (scene.connect_previous) {
        if (!previous) throw new Error("The preceding scene has no saved last frame.");
        output.beta2_previous_frame = { class_type: "LoadImage", inputs: { image: `${outputPath(previous)} [output]` } };
        const index = scene.references.length;
        conditioning.inputs[`ref_images.ref_image_${index}`] = ["beta2_previous_frame", 0];
        text += `\n\n<Picture ${index + 1}> is the final frame of the previous scene. Continue from its setting, lighting, character positions, poses, clothing and held objects, following the new action above. Use the individual character photos for identity.`;
    }
    conditioning.inputs.prompt = text;
    conditioning.inputs.length = scene.frames;
    output[targets.noise].inputs.noise_seed = scene.seed;
    output[targets.video].inputs.filename_prefix = `${prefix}/scene`;
    output[targets.video].inputs.save_output = true;
    output[targets.video].inputs.trim_to_audio = false;
    output[targets.last_frame].inputs.filename_prefix = `${prefix}/last_frame`;

    // Only selected references and the generation chain belong in this job.
    const keep = new Set();
    function visit(id) {
        id = String(id);
        if (keep.has(id)) return;
        const node = output[id];
        if (!node) throw new Error(`Missing connected node ${id}.`);
        keep.add(id);
        for (const value of Object.values(node.inputs)) {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) visit(value[0]);
        }
    }
    for (const id of [targets.video, targets.last_frame, ...targets.cleanup]) visit(id);
    return Object.fromEntries(Object.entries(output).filter(([id]) => keep.has(id)));
}

async function readApi(path) {
    const response = await api.fetchApi(path);
    if (!response.ok) throw new Error(`ComfyUI request failed (${response.status}): ${path}`);
    return response.json();
}

async function waitForJob(promptId, status) {
    let missing = 0;
    for (;;) {
        const history = await readApi(`/history/${encodeURIComponent(promptId)}`);
        const item = history[promptId];
        if (item) {
            if (item.status?.status_str === "error") {
                const detail = item.status.messages?.find(([type]) => type === "execution_error")?.[1];
                throw new Error(detail?.exception_message || "Scene was interrupted or failed. Check ComfyUI's queue.");
            }
            if (item.status?.completed) return item.outputs;
        } else {
            const queue = await readApi("/queue");
            const queued = [...queue.queue_running, ...queue.queue_pending].some(row => row[1] === promptId);
            missing = queued ? 0 : missing + 1;
            if (missing >= 3) throw new Error("The queued scene is no longer in ComfyUI's queue or history. Start a new run if the server was restarted.");
        }
        status();
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

function setStatus(node, message) {
    node.sceneStatus.value = message;
    node.setDirtyCanvas(true, true);
}

function storageKey(node) {
    return `beta2-scenes:${node.graph.id}:${node.id}`;
}

function saveRun(node, run) {
    localStorage.setItem(storageKey(node), JSON.stringify(run));
}

async function newRun(node) {
    const snapshot = await app.graphToPrompt();
    const references = Object.create(null);
    for (const item of snapshot.workflow.nodes) {
        if (item.type !== "LoadImage" || !item.title?.startsWith("REF:")) continue;
        const name = item.title.slice(4).trim();
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Reference name '${name}' must use letters, digits, underscores or hyphens, starting with a letter.`);
        if (references[name]) throw new Error(`Duplicate reference name: ${name}`);
        references[name] = String(item.id);
    }
    const plan = parseScenePlan(node.widgets.find(w => w.name === "scene_plan").value, references);
    const scenes = plan.scenes;
    const shared = plan.shared_prompt;
    const name = plan.run_name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "MyFilm";
    const run = { snapshot, references, scenes, shared, targets: structuredClone(node.properties.targets),
        prefix: `H3/Scenes/${name}_${Date.now()}`, results: [], pending: null, joined: null };
    for (let index = 0; index < scenes.length; index++) {
        const compiled = scenePrompt(snapshot.output, run.targets, references, scenes[index], shared,
            index ? { filename: "preflight.png", subfolder: "H3" } : null, "preflight");
        for (const ref of scenes[index].references) {
            if (!compiled[references[ref]].inputs.image) throw new Error(`Upload a photo for REF: ${ref} before starting.`);
        }
    }
    return run;
}

export async function runScenes(node, reset) {
    if (node.sceneRunning) return;
    node.sceneRunning = true;
    node.sceneStop = false;
    let run;
    try {
        const saved = reset ? null : localStorage.getItem(storageKey(node));
        run = saved ? JSON.parse(saved) : await newRun(node);
        saveRun(node, run);
        if (run.joined) {
            setStatus(node, `Complete: ${outputPath(run.joined)}. Use New Run to apply edits.`);
            return;
        }
        for (let index = run.results.length; index < run.scenes.length; index++) {
            if (node.sceneStop) break;
            const scene = run.scenes[index];
            const progress = () => setStatus(node, `${node.sceneStop ? "Stopping after" : "Rendering"} scene ${index + 1}/${run.scenes.length} (${(scene.frames / 24).toFixed(2)}s). Keep this tab open.`);
            const output = scenePrompt(run.snapshot.output, run.targets, run.references, scene, run.shared,
                run.results[index - 1]?.last_frame, `${run.prefix}/${String(index + 1).padStart(3, "0")}`);
            if (!run.pending) {
                progress();
                const result = await api.queuePrompt(-1, { output, workflow: run.snapshot.workflow });
                run.pending = { prompt_id: result.prompt_id, kind: "scene" };
                saveRun(node, run);
            }
            const promptId = run.pending.prompt_id;
            const outputs = await waitForJob(promptId, progress);
            const video = outputs[run.targets.video]?.gifs?.find(file => file.type === "output" && file.filename.endsWith(".mp4"));
            const lastFrame = outputs[run.targets.last_frame]?.images?.[0];
            if (!video || !lastFrame) throw new Error("Scene completed without a saved video or last frame. Check the output nodes.");
            run.results.push({ prompt_id: promptId, video, last_frame: lastFrame, seed: scene.seed, frames: scene.frames });
            run.pending = null;
            saveRun(node, run);
        }
        if (node.sceneStop) {
            setStatus(node, `Stopped after ${run.results.length} scenes. Run / Resume continues from here.`);
            return;
        }
        setStatus(node, "Joining saved clips. All generated frames are retained.");
        if (!run.pending) {
            const output = { beta2_join: { class_type: "Beta2JoinScenes", inputs: { clips: JSON.stringify(run.results.map(r => outputPath(r.video))) } } };
            const result = await api.queuePrompt(-1, { output, workflow: run.snapshot.workflow });
            run.pending = { prompt_id: result.prompt_id, kind: "join" };
            saveRun(node, run);
        }
        const outputs = await waitForJob(run.pending.prompt_id, () => {});
        run.joined = outputs.beta2_join?.gifs?.[0];
        if (!run.joined) throw new Error("Joining completed without an output video.");
        run.pending = null;
        saveRun(node, run);
        setStatus(node, `Complete: ${outputPath(run.joined)}`);
    } catch (error) {
        // A failed job can be retried; a connection failure keeps its prompt ID.
        if (run?.pending) {
            try {
                const history = await readApi(`/history/${encodeURIComponent(run.pending.prompt_id)}`);
                if (history[run.pending.prompt_id]?.status?.status_str === "error") {
                    run.pending = null;
                    saveRun(node, run);
                }
            } catch (_) { /* Keep the pending job for reconnection. */ }
        }
        setStatus(node, `Stopped: ${error.message || JSON.stringify(error)}. Completed clips are saved.`);
    } finally {
        node.sceneRunning = false;
    }
}

app.registerExtension({
    name: "Beta2.SceneQueue",
    async setup() {
        const queuePrompt = app.queuePrompt;
        app.queuePrompt = async function (...args) {
            const controller = this.graph._nodes.find(node => node.type === "Beta2SceneQueue" && node.mode === 0);
            if (!controller) return queuePrompt.apply(this, args);
            void runScenes(controller, false);
            return true;
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Beta2SceneQueue") return;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            original?.apply(this, arguments);
            this.addWidget("button", "Run / Resume Scenes", null, () => runScenes(this, false), { serialize: false });
            this.addWidget("button", "New Run (use edited settings)", null, () => runScenes(this, true), { serialize: false });
            this.addWidget("button", "Stop After Current Scene", null, () => {
                this.sceneStop = true;
                if (this.sceneRunning) setStatus(this, "Will stop after the current scene finishes and saves.");
            }, { serialize: false });
            this.addWidget("button", "Open Joined Video", null, () => {
                const run = JSON.parse(localStorage.getItem(storageKey(this)) || "null");
                if (!run?.joined) return setStatus(this, "No joined video yet.");
                const query = new URLSearchParams({ filename: run.joined.filename, subfolder: run.joined.subfolder, type: "output" });
                window.open(api.apiURL(`/view?${query}`), "_blank", "noopener");
            }, { serialize: false });
            this.addWidget("button", "Download Run Log", null, () => {
                const data = localStorage.getItem(storageKey(this));
                if (!data) return setStatus(this, "No run has started yet.");
                const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = "scene-run.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }, { serialize: false });
            this.sceneStatus = this.addWidget("text", "status", "Ready. Run starts or resumes the scene plan. New Run applies edits.", () => {}, { serialize: false });
            this.setSize([700, 780]);
        };
    },
});
