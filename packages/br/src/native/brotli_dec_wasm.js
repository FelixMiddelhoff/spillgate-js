/* @ts-self-types="./brotli_dec_wasm.d.ts" */

export class BrotliDecStream {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrotliDecStreamFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brotlidecstream_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} input
     * @param {number} output_size
     * @returns {BrotliStreamResult}
     */
    dec(input, output_size) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.brotlidecstream_dec(this.__wbg_ptr, ptr0, len0, output_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BrotliStreamResult.__wrap(ret[0]);
    }
    /**
     * See [`Self::dec()`].
     *
     * For drop-in replacement of `brotli-wasm`.
     * @param {Uint8Array} input
     * @param {number} output_size
     * @returns {BrotliStreamResult}
     */
    decompress(input, output_size) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.brotlidecstream_decompress(this.__wbg_ptr, ptr0, len0, output_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BrotliStreamResult.__wrap(ret[0]);
    }
    constructor() {
        const ret = wasm.brotlidecstream_new();
        this.__wbg_ptr = ret >>> 0;
        BrotliDecStreamFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    total_out() {
        const ret = wasm.brotlidecstream_total_out(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) BrotliDecStream.prototype[Symbol.dispose] = BrotliDecStream.prototype.free;

/**
 * From [`brotli_decompressor::state::BrotliDecoderErrorCode`].
 * NOTICE: All numbers are reversed to positive, required by wasm_bindgen.
 * @enum {1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 19 | 20 | 21 | 22 | 25 | 26 | 27 | 30 | 31}
 */
export const BrotliDecStreamErrCode = Object.freeze({
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: 1, "1": "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE",
    BROTLI_DECODER_ERROR_FORMAT_RESERVED: 2, "2": "BROTLI_DECODER_ERROR_FORMAT_RESERVED",
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: 3, "3": "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE",
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: 4, "4": "BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET",
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: 5, "5": "BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME",
    BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: 6, "6": "BROTLI_DECODER_ERROR_FORMAT_CL_SPACE",
    BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: 7, "7": "BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE",
    BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: 8, "8": "BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT",
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: 9, "9": "BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1",
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: 10, "10": "BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2",
    BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: 11, "11": "BROTLI_DECODER_ERROR_FORMAT_TRANSFORM",
    BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: 12, "12": "BROTLI_DECODER_ERROR_FORMAT_DICTIONARY",
    BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: 13, "13": "BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS",
    BROTLI_DECODER_ERROR_FORMAT_PADDING_1: 14, "14": "BROTLI_DECODER_ERROR_FORMAT_PADDING_1",
    BROTLI_DECODER_ERROR_FORMAT_PADDING_2: 15, "15": "BROTLI_DECODER_ERROR_FORMAT_PADDING_2",
    BROTLI_DECODER_ERROR_FORMAT_DISTANCE: 16, "16": "BROTLI_DECODER_ERROR_FORMAT_DISTANCE",
    BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: 19, "19": "BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET",
    BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: 20, "20": "BROTLI_DECODER_ERROR_INVALID_ARGUMENTS",
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: 21, "21": "BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES",
    BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: 22, "22": "BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS",
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: 25, "25": "BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP",
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: 26, "26": "BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1",
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: 27, "27": "BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2",
    BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: 30, "30": "BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES",
    BROTLI_DECODER_ERROR_UNREACHABLE: 31, "31": "BROTLI_DECODER_ERROR_UNREACHABLE",
});

/**
 * Returned by every successful (de)compression.
 */
export class BrotliStreamResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(BrotliStreamResult.prototype);
        obj.__wbg_ptr = ptr;
        BrotliStreamResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrotliStreamResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_brotlistreamresult_free(ptr, 0);
    }
    /**
     * Output buffer
     * @returns {Uint8Array}
     */
    get buf() {
        const ret = wasm.__wbg_get_brotlistreamresult_buf(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Result code.
     *
     * See [`BrotliStreamResultCode`] for available values.
     *
     * When error, the error code is not passed here but rather goes to `Err`.
     * @returns {BrotliStreamResultCode}
     */
    get code() {
        const ret = wasm.__wbg_get_brotlistreamresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Consumed bytes of the input buffer
     * @returns {number}
     */
    get input_offset() {
        const ret = wasm.__wbg_get_brotlistreamresult_input_offset(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Output buffer
     * @param {Uint8Array} arg0
     */
    set buf(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_brotlistreamresult_buf(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Result code.
     *
     * See [`BrotliStreamResultCode`] for available values.
     *
     * When error, the error code is not passed here but rather goes to `Err`.
     * @param {BrotliStreamResultCode} arg0
     */
    set code(arg0) {
        wasm.__wbg_set_brotlistreamresult_code(this.__wbg_ptr, arg0);
    }
    /**
     * Consumed bytes of the input buffer
     * @param {number} arg0
     */
    set input_offset(arg0) {
        wasm.__wbg_set_brotlistreamresult_input_offset(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) BrotliStreamResult.prototype[Symbol.dispose] = BrotliStreamResult.prototype.free;

/**
 * Same as [`brotli_decompressor::BrotliResult`] except [`brotli_decompressor::BrotliResult::ResultFailure`].
 *
 * Always `> 0`.
 *
 * `ResultFailure` is removed
 * because we will convert the failure to an actual negative error code (if available) and pass it elsewhere.
 * @enum {1 | 2 | 3}
 */
export const BrotliStreamResultCode = Object.freeze({
    ResultSuccess: 1, "1": "ResultSuccess",
    NeedsMoreInput: 2, "2": "NeedsMoreInput",
    NeedsMoreOutput: 3, "3": "NeedsMoreOutput",
});

/**
 * See [`BrotliDecStream`].
 *
 * For drop-in replacement of `brotli-wasm`.
 */
export class DecompressStream {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecompressStreamFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decompressstream_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} input
     * @param {number} output_size
     * @returns {BrotliStreamResult}
     */
    decompress(input, output_size) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decompressstream_decompress(this.__wbg_ptr, ptr0, len0, output_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BrotliStreamResult.__wrap(ret[0]);
    }
    constructor() {
        const ret = wasm.decompressstream_new();
        this.__wbg_ptr = ret >>> 0;
        DecompressStreamFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    total_out() {
        const ret = wasm.decompressstream_total_out(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DecompressStream.prototype[Symbol.dispose] = DecompressStream.prototype.free;

/**
 * No error reporting included.
 * To get the detailed error code, use [`stream::BrotliDecStream`].
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function brotli_dec(input) {
    const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.brotli_dec(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * See [`brotli_dec`].
 *
 * For drop-in replacement of `brotli-wasm`.
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function decompress(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decompress(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_83742b46f01ce22d: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./brotli_dec_wasm_bg.js": import0,
    };
}

const BrotliDecStreamFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brotlidecstream_free(ptr >>> 0, 1));
const DecompressStreamFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decompressstream_free(ptr >>> 0, 1));
const BrotliStreamResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_brotlistreamresult_free(ptr >>> 0, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('brotli_dec_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
