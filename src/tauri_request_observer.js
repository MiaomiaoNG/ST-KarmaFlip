import { makeId } from './compat.js';

// TT 2.4.0: safeInvoke closes over this broker object and calls broker.invoke
// for each command. Observe that shared method, not the exported safeInvoke copy.
const OBSERVER_MARK = Symbol.for('ST-KarmaFlip.tauri-request-observer');
const REQUEST_FIELD = 'karmaflip_observer_id';
const GENERATE_COMMANDS = new Set(['generate_chat_completion', 'start_chat_completion_stream']);

function failureDetail(error) {
    const message = typeof error === 'string' ? error : String(error?.message || 'TT 请求失败');
    const details = error?.details;
    if (!details || typeof details !== 'object') return message;
    try {
        return JSON.stringify({ message, details });
    } catch {
        return message;
    }
}

function isCancellation(error, signal) {
    return signal?.aborted || error?.name === 'AbortError'
        || Object.prototype.hasOwnProperty.call(error?.cause || {}, 'Cancelled');
}

function notify(observation) {
    try {
        observation.listener?.(observation);
    } catch (error) {
        // An observer must never change the host command's result or rejection.
        console.error('[KarmaFlip] TT outcome observer failed:', error);
    }
}

function installObserver() {
    const host = globalThis.__TAURITAVERN__;
    const broker = host?.invoke?.broker;
    if (host?.abiVersion !== 2 || typeof broker?.invoke !== 'function') return null;
    if (broker.invoke[OBSERVER_MARK]) return broker.invoke[OBSERVER_MARK];
    const registry = { requests: new Map(), streams: new Map() };
    const upstream = broker.invoke;
    const wrapper = async function karmaFlipTauriInvoke(command, args, ...rest) {
        let observation = null;
        let forwardedArgs = args;
        if (GENERATE_COMMANDS.has(command) && args?.dto && typeof args.dto === 'object') {
            const id = args.dto[REQUEST_FIELD];
            observation = registry.requests.get(id) || null;
            if (Object.prototype.hasOwnProperty.call(args.dto, REQUEST_FIELD)) {
                const dto = { ...args.dto };
                delete dto[REQUEST_FIELD];
                delete dto.karmaflip_trace_id;
                forwardedArgs = { ...args, dto };
            }
            if (observation) {
                observation.bound = true;
                if (command === 'start_chat_completion_stream') {
                    observation.streamId = args.streamId;
                    registry.streams.set(args.streamId, observation);
                }
            }
        } else if (command === 'read_chat_completion_stream' || command === 'close_chat_completion_stream') {
            observation = registry.streams.get(args?.streamId) || null;
        }
        let result;
        try {
            result = await Reflect.apply(upstream, this, [command, forwardedArgs, ...rest]);
        } catch (error) {
            if (observation) {
                if (isCancellation(error, observation.signal)) observation.finish('cancelled');
                // TT retries one failed cursor read itself. Do not count the
                // first transport rejection as a generation failure.
                else if (command !== 'read_chat_completion_stream' || ++observation.readFailures >= 2) {
                    observation.finish('failure', failureDetail(error));
                }
            }
            throw error;
        }
        if (!observation) return result;
        if (command === 'generate_chat_completion') observation.finish('success');
        else if (command === 'read_chat_completion_stream') {
            observation.readFailures = 0;
            const events = Array.isArray(result?.events) ? result.events : [];
            for (const event of events) {
                const seq = Number(event?.seq);
                if (!Number.isSafeInteger(seq) || seq !== observation.lastSeq + 1) {
                    observation.finish('failure', 'TT 流式事件序号不连续');
                    break;
                }
                observation.lastSeq = seq;
                if (event.type === 'error') {
                    observation.finish('failure', failureDetail(event));
                    break;
                }
                if (event.type === 'done') observation.finish('success');
                else if (event.type === 'chunk') observation.ready();
            }
            if (result?.status === 'cancelled') observation.finish('cancelled');
            else if (events.length === 0 && result?.status === 'done') observation.finish('success');
            else if (events.length === 0 && result?.status !== 'running') {
                observation.finish('failure', 'TT 流式会话未收到正常终止事件');
            }
        } else if (command === 'close_chat_completion_stream') observation.finish('cancelled');
        return result;
    };
    Object.defineProperty(wrapper, OBSERVER_MARK, { value: registry });
    try {
        broker.invoke = wrapper;
    } catch {
        return null;
    }
    return broker.invoke === wrapper ? registry : null;
}

export function beginTauriRequest(init) {
    const registry = installObserver();
    if (!registry || typeof init?.body !== 'string') return null;
    const body = init.body.trim();
    if (!body.startsWith('{') || !body.endsWith('}')) return null;
    const id = makeId('kf_tt');
    let resolveReady;
    const observation = {
        id, bound: false, streamId: null, status: 'pending', detail: '',
        signal: init.signal, lastSeq: 0, readFailures: 0, listener: null,
        firstEvent: new Promise(resolve => { resolveReady = resolve; }),
        ready() { resolveReady(); },
        finish(status, detail = '') {
            if (this.status !== 'pending') return;
            this.status = status;
            this.detail = detail;
            this.release();
            this.ready();
            notify(this);
        },
        release() {
            registry.requests.delete(id);
            if (this.streamId) registry.streams.delete(this.streamId);
            this.signal?.removeEventListener('abort', onAbort);
        },
        dispose() {
            this.listener = null;
            if (this.status === 'pending') this.status = 'disposed';
            this.release();
            this.ready();
        },
        onOutcome(listener) {
            this.listener = listener;
            if (this.status !== 'pending' && this.status !== 'disposed') notify(this);
        },
    };
    const onAbort = () => observation.finish('cancelled');
    registry.requests.set(id, observation);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    if (init.signal?.aborted) onAbort();
    // The host will parse this JSON itself. Append only the private scalar;
    // do not parse/stringify the entire prompt again on mobile devices.
    const comma = /^\{\s*\}$/.test(body) ? '' : ',';
    return {
        init: { ...init, body: `${body.slice(0, -1)}${comma}"${REQUEST_FIELD}":${JSON.stringify(id)}}` },
        observation,
    };
}

export function clearTauriRequestObservations() {
    const registry = globalThis.__TAURITAVERN__?.invoke?.broker?.invoke?.[OBSERVER_MARK];
    if (!registry) return;
    for (const observation of [...registry.requests.values()]) observation.dispose();
}
