/*
 * camera-grid-card
 * Camera grid for go2rtc streams. If one of a camera's trigger entities
 * switches to the trigger state, that camera opens as a single full-screen
 * overlay until a human closes it (X button, Esc, or optional auto-close).
 *
 * Install: copy to /config/www/camera-grid-card.js and add a dashboard
 * resource  /local/camera-grid-card.js  (type: JavaScript module).
 */

const CARD_VERSION = "1.2.0";

/*
 * ---- Vendored: go2rtc VideoRTC player (MIT, Copyright (c) 2022 Alexey Khit,
 * https://github.com/AlexxIT/go2rtc). Bundled so the card does not need to
 * load scripts from the go2rtc host (which often blocks cross-origin loads).
 * Local change: one readyState guard in the MSE updateend handler (marked).
 */
/**
 * VideoRTC v1.6.0 - Video player for go2rtc streaming application.
 *
 * All modern web technologies are supported in almost any browser except Apple Safari.
 *
 * Support:
 * - ECMAScript 2017 (ES8) = ES6 + async
 * - RTCPeerConnection for Safari iOS 11.0+
 * - IntersectionObserver for Safari iOS 12.2+
 * - ManagedMediaSource for Safari 17+
 *
 * Doesn't support:
 * - MediaSource for Safari iOS
 * - Customized built-in elements (extends HTMLVideoElement) because Safari
 * - Autoplay for WebRTC in Safari
 */
class VideoRTC extends HTMLElement {
    constructor() {
        super();

        this.DISCONNECT_TIMEOUT = 5000;
        this.RECONNECT_TIMEOUT = 15000;

        this.CODECS = [
            'avc1.640029',      // H.264 high 4.1 (Chromecast 1st and 2nd Gen)
            'avc1.64002A',      // H.264 high 4.2 (Chromecast 3rd Gen)
            'avc1.640033',      // H.264 high 5.1 (Chromecast with Google TV)
            'hvc1.1.6.L153.B0', // H.265 main 5.1 (Chromecast Ultra)
            'mp4a.40.2',        // AAC LC
            'mp4a.40.5',        // AAC HE
            'flac',             // FLAC (PCM compatible)
            'opus',             // OPUS Chrome, Firefox
        ];

        /**
         * [config] Supported modes (webrtc, webrtc/tcp, mse, hls, mp4, mjpeg).
         * @type {string}
         */
        this.mode = 'webrtc,mse,hls,mjpeg';

        /**
         * [Config] Requested medias (video, audio, microphone).
         * @type {string}
         */
        this.media = 'video,audio';

        /**
         * [config] Run stream when not displayed on the screen. Default `false`.
         * @type {boolean}
         */
        this.background = false;

        /**
         * [config] Run stream only when player in the viewport. Stop when user scroll out player.
         * Value is percentage of visibility from `0` (not visible) to `1` (full visible).
         * Default `0` - disable;
         * @type {number}
         */
        this.visibilityThreshold = 0;

        /**
         * [config] Run stream only when browser page on the screen. Stop when user change browser
         * tab or minimise browser windows.
         * @type {boolean}
         */
        this.visibilityCheck = true;

        /**
         * [config] WebRTC configuration
         * @type {RTCConfiguration}
         */
        this.pcConfig = {
            bundlePolicy: 'max-bundle',
            iceServers: [{urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']}],
            sdpSemantics: 'unified-plan',  // important for Chromecast 1
        };

        /**
         * [info] WebSocket connection state. Values: CONNECTING, OPEN, CLOSED
         * @type {number}
         */
        this.wsState = WebSocket.CLOSED;

        /**
         * [info] WebRTC connection state.
         * @type {number}
         */
        this.pcState = WebSocket.CLOSED;

        /**
         * @type {HTMLVideoElement}
         */
        this.video = null;

        /**
         * @type {WebSocket}
         */
        this.ws = null;

        /**
         * @type {string|URL}
         */
        this.wsURL = '';

        /**
         * @type {RTCPeerConnection}
         */
        this.pc = null;

        /**
         * @type {number}
         */
        this.connectTS = 0;

        /**
         * @type {string}
         */
        this.mseCodecs = '';

        /**
         * [internal] Disconnect TimeoutID.
         * @type {number}
         */
        this.disconnectTID = 0;

        /**
         * [internal] Reconnect TimeoutID.
         * @type {number}
         */
        this.reconnectTID = 0;

        /**
         * [internal] Handler for receiving Binary from WebSocket.
         * @type {Function}
         */
        this.ondata = null;

        /**
         * [internal] Handlers list for receiving JSON from WebSocket.
         * @type {Object.<string,Function>}
         */
        this.onmessage = null;
    }

    /**
     * Set video source (WebSocket URL). Support relative path.
     * @param {string|URL} value
     */
    set src(value) {
        if (typeof value !== 'string') value = value.toString();
        if (value.startsWith('http')) {
            value = 'ws' + value.substring(4);
        } else if (value.startsWith('/')) {
            value = 'ws' + location.origin.substring(4) + value;
        }

        this.wsURL = value;

        this.onconnect();
    }

    /**
     * Play video. Support automute when autoplay blocked.
     * https://developer.chrome.com/blog/autoplay/
     */
    play() {
        this.video.play().catch(() => {
            if (!this.video.muted) {
                this.video.muted = true;
                this.video.play().catch(er => {
                    console.warn(er);
                });
            }
        });
    }

    /**
     * Send message to server via WebSocket
     * @param {Object} value
     */
    send(value) {
        if (this.ws) this.ws.send(JSON.stringify(value));
    }

    /** @param {Function} isSupported */
    codecs(isSupported) {
        return this.CODECS
            .filter(codec => this.media.includes(codec.includes('vc1') ? 'video' : 'audio'))
            .filter(codec => isSupported(`video/mp4; codecs="${codec}"`)).join();
    }

    /**
     * `CustomElement`. Invoked each time the custom element is appended into a
     * document-connected element.
     */
    connectedCallback() {
        if (this.disconnectTID) {
            clearTimeout(this.disconnectTID);
            this.disconnectTID = 0;
        }

        // because video autopause on disconnected from DOM
        if (this.video) {
            const seek = this.video.seekable;
            if (seek.length > 0) {
                this.video.currentTime = seek.end(seek.length - 1);
            }
            this.play();
        } else {
            this.oninit();
        }

        this.onconnect();
    }

    /**
     * `CustomElement`. Invoked each time the custom element is disconnected from the
     * document's DOM.
     */
    disconnectedCallback() {
        if (this.background || this.disconnectTID) return;
        if (this.wsState === WebSocket.CLOSED && this.pcState === WebSocket.CLOSED) return;

        this.disconnectTID = setTimeout(() => {
            if (this.reconnectTID) {
                clearTimeout(this.reconnectTID);
                this.reconnectTID = 0;
            }

            this.disconnectTID = 0;

            this.ondisconnect();
        }, this.DISCONNECT_TIMEOUT);
    }

    /**
     * Creates child DOM elements. Called automatically once on `connectedCallback`.
     */
    oninit() {
        this.video = document.createElement('video');
        this.video.controls = true;
        this.video.playsInline = true;
        this.video.preload = 'auto';

        this.video.style.display = 'block'; // fix bottom margin 4px
        this.video.style.width = '100%';
        this.video.style.height = '100%';

        this.appendChild(this.video);

        this.video.addEventListener('error', ev => {
            const err = this.video.error;
            // https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
            const MEDIA_ERRORS = {
                1: 'MEDIA_ERR_ABORTED',
                2: 'MEDIA_ERR_NETWORK',
                3: 'MEDIA_ERR_DECODE',
                4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
            };
            console.error('[VideoRTC] Video error:', {
                error: err ? MEDIA_ERRORS[err.code] : 'unknown',
                message: err ? err.message : 'unknown',
                codecs: this.mseCodecs || 'not set',
                readyState: this.video.readyState,
                networkState: this.video.networkState,
                currentTime: this.video.currentTime
            });
            if (this.ws) this.ws.close(); // run reconnect for broken MSE stream
        });

        // all Safari lies about supported audio codecs
        const m = window.navigator.userAgent.match(/Version\/(\d+).+Safari/);
        if (m) {
            // AAC from v13, FLAC from v14, OPUS - unsupported
            const skip = m[1] < '13' ? 'mp4a.40.2' : m[1] < '14' ? 'flac' : 'opus';
            this.CODECS.splice(this.CODECS.indexOf(skip));
        }

        if (this.background) return;

        if ('hidden' in document && this.visibilityCheck) {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.disconnectedCallback();
                } else if (this.isConnected) {
                    this.connectedCallback();
                }
            });
        }

        if ('IntersectionObserver' in window && this.visibilityThreshold) {
            const observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) {
                        this.disconnectedCallback();
                    } else if (this.isConnected) {
                        this.connectedCallback();
                    }
                });
            }, {threshold: this.visibilityThreshold});
            observer.observe(this);
        }
    }

    /**
     * Connect to WebSocket. Called automatically on `connectedCallback`.
     * @return {boolean} true if the connection has started.
     */
    onconnect() {
        if (!this.isConnected || !this.wsURL || this.ws || this.pc) return false;

        // CLOSED or CONNECTING => CONNECTING
        this.wsState = WebSocket.CONNECTING;

        this.connectTS = Date.now();

        this.ws = new WebSocket(this.wsURL);
        this.ws.binaryType = 'arraybuffer';
        this.ws.addEventListener('open', () => this.onopen());
        this.ws.addEventListener('close', () => this.onclose());

        return true;
    }

    ondisconnect() {
        this.wsState = WebSocket.CLOSED;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.pcState = WebSocket.CLOSED;
        if (this.pc) {
            this.pc.getSenders().forEach(sender => {
                if (sender.track) sender.track.stop();
            });
            this.pc.close();
            this.pc = null;
        }

        this.video.src = '';
        this.video.srcObject = null;
    }

    /**
     * @returns {Array.<string>} of modes (mse, webrtc, etc.)
     */
    onopen() {
        // CONNECTING => OPEN
        this.wsState = WebSocket.OPEN;

        this.ws.addEventListener('message', ev => {
            if (typeof ev.data === 'string') {
                const msg = JSON.parse(ev.data);
                for (const mode in this.onmessage) {
                    this.onmessage[mode](msg);
                }
            } else {
                this.ondata(ev.data);
            }
        });

        this.ondata = null;
        this.onmessage = {};

        const modes = [];

        if (this.mode.includes('mse') && ('MediaSource' in window || 'ManagedMediaSource' in window)) {
            modes.push('mse');
            this.onmse();
        } else if (this.mode.includes('hls') && this.video.canPlayType('application/vnd.apple.mpegurl')) {
            modes.push('hls');
            this.onhls();
        } else if (this.mode.includes('mp4')) {
            modes.push('mp4');
            this.onmp4();
        }

        if (this.mode.includes('webrtc') && 'RTCPeerConnection' in window) {
            modes.push('webrtc');
            this.onwebrtc();
        }

        if (this.mode.includes('mjpeg')) {
            if (modes.length) {
                this.onmessage['mjpeg'] = msg => {
                    if (msg.type !== 'error' || msg.value.indexOf(modes[0]) !== 0) return;
                    this.onmjpeg();
                };
            } else {
                modes.push('mjpeg');
                this.onmjpeg();
            }
        }

        return modes;
    }

    /**
     * @return {boolean} true if reconnection has started.
     */
    onclose() {
        if (this.wsState === WebSocket.CLOSED) return false;

        // CONNECTING, OPEN => CONNECTING
        this.wsState = WebSocket.CONNECTING;
        this.ws = null;

        // reconnect no more than once every X seconds
        const delay = Math.max(this.RECONNECT_TIMEOUT - (Date.now() - this.connectTS), 0);

        this.reconnectTID = setTimeout(() => {
            this.reconnectTID = 0;
            this.onconnect();
        }, delay);

        return true;
    }

    onmse() {
        /** @type {MediaSource} */
        let ms;

        if ('ManagedMediaSource' in window) {
            const MediaSource = window.ManagedMediaSource;

            ms = new MediaSource();
            ms.addEventListener('sourceopen', () => {
                this.send({type: 'mse', value: this.codecs(MediaSource.isTypeSupported)});
            }, {once: true});

            this.video.disableRemotePlayback = true;
            this.video.srcObject = ms;
        } else {
            ms = new MediaSource();
            ms.addEventListener('sourceopen', () => {
                URL.revokeObjectURL(this.video.src);
                this.send({type: 'mse', value: this.codecs(MediaSource.isTypeSupported)});
            }, {once: true});

            this.video.src = URL.createObjectURL(ms);
            this.video.srcObject = null;
        }

        this.play();

        this.mseCodecs = '';

        this.onmessage['mse'] = msg => {
            if (msg.type !== 'mse') return;

            this.mseCodecs = msg.value;

            const sb = ms.addSourceBuffer(msg.value);
            sb.mode = 'segments'; // segments or sequence
            sb.addEventListener('updateend', () => {
                if (!sb.updating && bufLen > 0) {
                    try {
                        const data = buf.slice(0, bufLen);
                        sb.appendBuffer(data);
                        bufLen = 0;
                    } catch (e) {
                        // console.debug(e);
                    }
                }

                // camera-grid-card patch: ignore updateend after the stream was released
                if (ms.readyState === 'open' && !sb.updating && sb.buffered && sb.buffered.length) {
                    const end = sb.buffered.end(sb.buffered.length - 1);
                    const start = end - 5;
                    const start0 = sb.buffered.start(0);
                    if (start > start0) {
                        sb.remove(start0, start);
                        ms.setLiveSeekableRange(start, end);
                    }
                    if (this.video.currentTime < start) {
                        this.video.currentTime = start;
                    }
                    const gap = end - this.video.currentTime;
                    this.video.playbackRate = gap > 0.1 ? gap : 0.1;
                    // console.debug('VideoRTC.buffered', gap, this.video.playbackRate, this.video.readyState);
                }
            });

            const buf = new Uint8Array(2 * 1024 * 1024);
            let bufLen = 0;

            this.ondata = data => {
                if (sb.updating || bufLen > 0) {
                    const b = new Uint8Array(data);
                    buf.set(b, bufLen);
                    bufLen += b.byteLength;
                    // console.debug('VideoRTC.buffer', b.byteLength, bufLen);
                } else {
                    try {
                        sb.appendBuffer(data);
                    } catch (e) {
                        // console.debug(e);
                    }
                }
            };
        };
    }

    onwebrtc() {
        const pc = new RTCPeerConnection(this.pcConfig);

        pc.addEventListener('icecandidate', ev => {
            if (ev.candidate && this.mode.includes('webrtc/tcp') && ev.candidate.protocol === 'udp') return;

            const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
            this.send({type: 'webrtc/candidate', value: candidate});
        });

        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') {
                const tracks = pc.getTransceivers()
                    .filter(tr => tr.currentDirection === 'recvonly') // skip inactive
                    .map(tr => tr.receiver.track);
                /** @type {HTMLVideoElement} */
                const video2 = document.createElement('video');
                video2.addEventListener('loadeddata', () => this.onpcvideo(video2), {once: true});
                video2.srcObject = new MediaStream(tracks);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                pc.close(); // stop next events

                this.pcState = WebSocket.CLOSED;
                this.pc = null;

                this.onconnect();
            }
        });

        this.onmessage['webrtc'] = msg => {
            switch (msg.type) {
                case 'webrtc/candidate':
                    if (this.mode.includes('webrtc/tcp') && msg.value.includes(' udp ')) return;

                    pc.addIceCandidate({candidate: msg.value, sdpMid: '0'}).catch(er => {
                        console.warn(er);
                    });
                    break;
                case 'webrtc/answer':
                    pc.setRemoteDescription({type: 'answer', sdp: msg.value}).catch(er => {
                        console.warn(er);
                    });
                    break;
                case 'error':
                    if (!msg.value.includes('webrtc/offer')) return;
                    pc.close();
            }
        };

        this.createOffer(pc).then(offer => {
            this.send({type: 'webrtc/offer', value: offer.sdp});
        });

        this.pcState = WebSocket.CONNECTING;
        this.pc = pc;
    }

    /**
     * @param pc {RTCPeerConnection}
     * @return {Promise<RTCSessionDescriptionInit>}
     */
    async createOffer(pc) {
        try {
            if (this.media.includes('microphone')) {
                const media = await navigator.mediaDevices.getUserMedia({audio: true});
                media.getTracks().forEach(track => {
                    pc.addTransceiver(track, {direction: 'sendonly'});
                });
            }
        } catch (e) {
            console.warn(e);
        }

        for (const kind of ['video', 'audio']) {
            if (this.media.includes(kind)) {
                pc.addTransceiver(kind, {direction: 'recvonly'});
            }
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    /**
     * @param video2 {HTMLVideoElement}
     */
    onpcvideo(video2) {
        if (this.pc) {
            // Video+Audio > Video, H265 > H264, Video > Audio, WebRTC > MSE
            let rtcPriority = 0, msePriority = 0;

            /** @type {MediaStream} */
            const stream = video2.srcObject;
            if (stream.getVideoTracks().length > 0) {
                // not the best, but a pretty simple way to check a codec
                const isH265Supported =  this.pc.remoteDescription.sdp.includes('H265/90000');
                rtcPriority += isH265Supported ? 0x240 : 0x220;
            }
            if (stream.getAudioTracks().length > 0) rtcPriority += 0x102;

            if (this.mseCodecs.includes('hvc1.')) msePriority += 0x230;
            if (this.mseCodecs.includes('avc1.')) msePriority += 0x210;
            if (this.mseCodecs.includes('mp4a.')) msePriority += 0x101;

            if (rtcPriority >= msePriority) {
                this.video.srcObject = stream;
                this.play();

                this.pcState = WebSocket.OPEN;

                this.wsState = WebSocket.CLOSED;
                if (this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
            } else {
                this.pcState = WebSocket.CLOSED;
                if (this.pc) {
                    this.pc.close();
                    this.pc = null;
                }
            }
        }

        video2.srcObject = null;
    }

    onmjpeg() {
        this.ondata = data => {
            this.video.controls = false;
            this.video.poster = 'data:image/jpeg;base64,' + VideoRTC.btoa(data);
        };

        this.send({type: 'mjpeg'});
    }

    onhls() {
        this.onmessage['hls'] = msg => {
            if (msg.type !== 'hls') return;

            const url = 'http' + this.wsURL.substring(2, this.wsURL.indexOf('/ws')) + '/hls/';
            const playlist = msg.value.replace('hls/', url);
            this.video.src = 'data:application/vnd.apple.mpegurl;base64,' + btoa(playlist);
            this.play();
        };

        this.send({type: 'hls', value: this.codecs(type => this.video.canPlayType(type))});
    }

    onmp4() {
        /** @type {HTMLCanvasElement} **/
        const canvas = document.createElement('canvas');
        /** @type {CanvasRenderingContext2D} */
        let context;

        /** @type {HTMLVideoElement} */
        const video2 = document.createElement('video');
        video2.autoplay = true;
        video2.playsInline = true;
        video2.muted = true;

        video2.addEventListener('loadeddata', () => {
            if (!context) {
                canvas.width = video2.videoWidth;
                canvas.height = video2.videoHeight;
                context = canvas.getContext('2d');
            }

            context.drawImage(video2, 0, 0, canvas.width, canvas.height);

            this.video.controls = false;
            this.video.poster = canvas.toDataURL('image/jpeg');
        });

        this.ondata = data => {
            video2.src = 'data:video/mp4;base64,' + VideoRTC.btoa(data);
        };

        this.send({type: 'mp4', value: this.codecs(this.video.canPlayType)});
    }

    static btoa(buffer) {
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        let binary = '';
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }
}
/* ---- End of vendored code ---- */

class CameraGridStream extends VideoRTC {
  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = true;
    this.video.style.pointerEvents = "none";
  }
}
if (!customElements.get("camera-grid-stream")) {
  customElements.define("camera-grid-stream", CameraGridStream);
}

function wsUrl(base, stream) {
  const u = new URL(`${base.replace(/\/+$/, "")}/api/ws`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("src", stream);
  return u.toString();
}

// Build a stream element for a camera.
function makeStream(cam, globalUrl) {
  const base = cam.url || globalUrl;
  const el = document.createElement("camera-grid-stream");
  if (base && cam.stream) el.src = wsUrl(base, cam.stream);
  return el;
}


// "Has real frames". Players pause themselves in hidden tabs, so a paused
// video only counts as not playing while the tab is visible.
const isPlaying = (v) =>
  !!v && v.readyState >= 3 && v.currentTime > 0.2 && (!v.paused || document.hidden);

/*
 * A camera with a low- and a high-quality go2rtc stream. go2rtc has no
 * adaptive bitrate (one stream name = one quality), so the card does the
 * switching itself:
 *   - low is shown first (fast start);
 *   - high is loaded on top and takes over once it is really playing;
 *   - in "auto" mode it falls back to low when the network looks poor
 *     (Network Information API where available) or high keeps stalling, and
 *     tries high again after a cool-down.
 * Modes: "low" (low only), "high" (low first, then high, never downgrade),
 * "auto" (like high, but may fall back to low).
 */
class AdaptiveStream {
  constructor(cam, globalUrl, cfg) {
    this._url = cam.url || globalUrl;
    this._highName = cam.stream;
    this._lowName = cam.stream_low;
    this._cfg = cfg;
    this._mode = "low";
    this._lowEl = null;
    this._highEl = null;
    this._highReady = false;
    this._highSince = 0;
    this._readyAt = 0;
    this._retryAt = 0;
    this._stalls = [];
    this._bufSince = 0;
    this._timer = null;
    this._onNet = () => this._apply();
    this.el = document.createElement("div");
    this.el.className = "adaptive";
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 500);
    navigator.connection?.addEventListener?.("change", this._onNet);
    this._apply();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    navigator.connection?.removeEventListener?.("change", this._onNet);
  }

  destroy() {
    this.stop();
    this._drop("_lowEl");
    this._drop("_highEl");
    this.el.remove();
  }

  setMode(mode) {
    this._mode = mode;
    this._retryAt = 0;
    this._stalls = [];
    this._bufSince = 0;
    this._apply();
  }

  get quality() {
    return this._highEl && this._highReady ? "high" : "low";
  }

  _netPoor() {
    const n = navigator.connection;
    if (!n) return false;
    if (n.saveData) return true;
    if (["slow-2g", "2g", "3g"].includes(n.effectiveType)) return true;
    const min = Number(this._cfg.min_downlink_mbps);
    return min > 0 && n.downlink > 0 && n.downlink < min;
  }

  _wantHigh() {
    if (this._mode === "low") return false;
    if (this._mode === "high") return true;
    return !this._netPoor() && Date.now() >= this._retryAt;
  }

  _make(name, z) {
    const el = document.createElement("camera-grid-stream");
    el.src = wsUrl(this._url, name);
    el.style.cssText = `position:absolute;inset:0;z-index:${z}`;
    this.el.appendChild(el);
    return el;
  }

  _drop(key) {
    // Releasing a stream makes the player log a harmless "Empty src" error.
    this[key]?.video?.addEventListener("error", (e) => e.stopImmediatePropagation(), true);
    this[key]?.remove();
    this[key] = null;
    if (key === "_highEl") this._highReady = false;
  }

  _apply() {
    if (this._wantHigh()) {
      if (!this._highEl) {
        if (!this._lowEl) this._lowEl = this._make(this._lowName, 1);
        this._highEl = this._make(this._highName, 0);
        this._highReady = false;
        this._highSince = Date.now();
      }
    } else if (!this._lowEl) {
      this._lowEl = this._make(this._lowName, 1);
    }
  }

  _downgrade() {
    this._retryAt = Date.now() + Number(this._cfg.retry_high_seconds) * 1000;
    this._stalls = [];
    this._bufSince = 0;
    this._apply();
  }

  _tick() {
    const now = Date.now();
    const wantHigh = this._wantHigh();
    if (wantHigh !== !!this._highEl || (!wantHigh && !this._lowEl)) this._apply();

    const hv = this._highEl?.video;
    if (hv && !hv._cgcWatched) {
      hv._cgcWatched = true;
      hv.addEventListener("waiting", () => {
        if (this._highReady) this._stalls.push(Date.now());
      });
    }

    if (this._highEl && wantHigh) {
      if (!this._highReady && isPlaying(hv)) {
        // High is really playing: put it on top, then release low.
        this._highReady = true;
        this._readyAt = now;
        this._highEl.style.zIndex = "2";
      }
      if (this._highReady && this._lowEl && now - this._readyAt > 400) {
        this._drop("_lowEl");
      }
    } else if (this._highEl && isPlaying(this._lowEl?.video)) {
      // Falling back: low is playing underneath, release high.
      this._drop("_highEl");
    }

    if (this._mode !== "auto" || !this._highEl || !wantHigh || document.hidden) return;

    if (!this._highReady) {
      // High never got going: stop wasting bandwidth for a while.
      if (now - this._highSince > 20000) {
        this._downgrade();
      }
      return;
    }
    this._stalls = this._stalls.filter((t) => now - t < 30000);
    if (hv && hv.readyState < 3) this._bufSince ||= now;
    else this._bufSince = 0;
    if (
      this._stalls.length >= Number(this._cfg.stall_limit) ||
      (this._bufSince && now - this._bufSince > 5000)
    ) {
      this._downgrade();
    }
  }
}

// "16:9" | "16x9" | "1.78" | "56%" -> width / height as a number
function parseAspect(v) {
  const s = String(v).trim();
  let r = NaN;
  if (s.endsWith("%")) r = 100 / parseFloat(s);
  else if (/[:x]/.test(s)) {
    const [w, h] = s.split(/[:x]/).map(parseFloat);
    r = w / h;
  } else r = parseFloat(s);
  return Number.isFinite(r) && r > 0 ? r : 16 / 9;
}

const STREAM_CSS = `
  camera-grid-stream { display:block; width:100%; height:100%; }
  camera-grid-stream video { width:100%; height:100%; object-fit: var(--cgc-fit, cover); }
`;

class CameraGridCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = null;
    this._tiles = new Map();
    this._entityCards = [];
    this._adaptive = new Map();
    this._openId = null;
    this._gen = 0;
    this._closeTimer = null;
  }

  static getConfigElement() {
    return document.createElement("camera-grid-card-editor");
  }

  static getStubConfig() {
    return {
      columns: 2,
      go2rtc_url: "http://homeassistant.local:1984",
      cameras: [],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.cameras)) {
      throw new Error("`cameras` must be a list");
    }
    this._config = {
      columns: 2,
      aspect_ratio: "16:9",
      fit: "cover",
      trigger_state: "on",
      auto_close_seconds: 0,
      show_titles: true,
      grid_quality: "low",
      fullscreen_quality: "auto",
      min_downlink_mbps: 3,
      stall_limit: 3,
      retry_high_seconds: 60,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    for (const card of this._entityCards) card.hass = hass;
    if (old && this._config) this._checkTriggers(old, hass);
  }

  getCardSize() {
    const rows = Math.ceil(this._config.cameras.length / this._config.columns);
    return Math.max(1, rows * 3);
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 3 };
  }

  connectedCallback() {
    for (const a of this._adaptive.values()) a.start();
  }

  disconnectedCallback() {
    this._closeOverlay();
    for (const a of this._adaptive.values()) a.stop();
  }

  _id(cam) {
    return cam.id || cam.stream || cam.entity || cam.camera_entity;
  }

  _checkTriggers(oldHass, hass) {
    const t = this._config.trigger_state;
    const wanted = Array.isArray(t) ? t.map(String) : [String(t)];
    const any = wanted.includes("*");
    for (const cam of this._config.cameras) {
      for (const entity of cam.triggers || []) {
        const prev = oldHass.states[entity];
        const next = hass.states[entity];
        if (prev === next || !next) continue;
        // Fire on every state transition into a wanted state (attribute-only
        // updates are ignored), so off -> on -> off -> on fires each time.
        const changed = !prev || prev.state !== next.state;
        if (changed && (any || wanted.includes(next.state))) {
          this.focusCamera(this._id(cam));
          return;
        }
      }
    }
  }

  // Camera source: HA camera entity (via HA's own live view), go2rtc stream,
  // or a placeholder while the config is incomplete.
  _makeSource(cam) {
    const entity = cam.entity || cam.camera_entity;
    if (entity) return this._makeEntityView(entity);
    if (cam.stream && cam.stream_low) {
      const a = new AdaptiveStream(cam, this._config.go2rtc_url, this._config);
      a.setMode(this._config.grid_quality);
      this._adaptive.set(this._id(cam), a);
      return a.el;
    }
    if (cam.stream) return makeStream(cam, this._config.go2rtc_url);
    const p = document.createElement("div");
    p.className = "placeholder";
    p.textContent = "Set a go2rtc stream or a camera entity";
    return p;
  }

  _makeEntityView(entity) {
    const c = this._config;
    const gen = this._gen;
    const wrap = document.createElement("div");
    wrap.className = "entity-view";
    const fail = (err) => {
      wrap.textContent = `Cannot show ${entity}`;
      console.error("camera-grid-card:", err);
    };
    if (typeof window.loadCardHelpers !== "function") {
      fail(new Error("loadCardHelpers is not available"));
      return wrap;
    }
    window
      .loadCardHelpers()
      .then((helpers) =>
        helpers.createCardElement({
          type: "picture-entity",
          entity,
          camera_view: "live",
          show_name: false,
          show_state: false,
          aspect_ratio: String(c.aspect_ratio),
          fit_mode: c.fit,
          tap_action: { action: "none" },
          hold_action: { action: "none" },
          double_tap_action: { action: "none" },
        })
      )
      .then((card) => {
        if (gen !== this._gen) return; // re-rendered meanwhile
        if (this._hass) card.hass = this._hass;
        wrap.appendChild(card);
        this._entityCards.push(card);
      })
      .catch(fail);
    return wrap;
  }

  _render() {
    this._closeOverlay();
    this._gen++;
    this._entityCards = [];
    for (const a of this._adaptive.values()) a.destroy();
    this._adaptive = new Map();
    const c = this._config;
    const root = this.shadowRoot;
    const ar = parseAspect(c.aspect_ratio);
    // Full-screen styles, applied to the very same tile element that is in
    // the grid, so the already-playing stream is never remounted. Written as
    // two separate rules because one unsupported selector would void a list.
    const openRules = (sel) => `
        ${sel} { position:fixed; inset:0; width:100vw; height:100vh;
                 height:100dvh; border-radius:0; cursor:default;
                 z-index:99999; --cgc-fit:contain; }
        ${sel} .close { display:block; }
        ${sel} .entity-view > * { width:min(100vw, calc(100vh * ${ar}));
                                  width:min(100vw, calc(100dvh * ${ar})); }
        ${sel} .title { left:16px; top:20px; bottom:auto; font-size:16px; }`;
    root.innerHTML = `
      <style>
        ${STREAM_CSS}
        :host { display:block; --cgc-fit:${c.fit}; }
        .grid { display:grid; gap:4px;
                grid-template-columns: repeat(${Number(c.columns) || 2}, 1fr); }
        .cell { position:relative;
                aspect-ratio:${String(c.aspect_ratio).replace(":", " / ")}; }
        .tile { position:absolute; inset:0; width:auto; height:auto; margin:0;
                padding:0; border:0; display:block; overflow:hidden;
                background:#000; color:#fff;
                border-radius: var(--ha-card-border-radius, 12px);
                cursor:pointer; }
        .title { position:absolute; left:8px; bottom:6px; color:#fff;
                 font-size:12px; text-shadow:0 0 4px #000; pointer-events:none; }
        .close { display:none; position:absolute;
                 top:max(12px, env(safe-area-inset-top)); right:12px;
                 width:48px; height:48px; border-radius:50%; border:0;
                 background:rgba(0,0,0,.6); color:#fff; font-size:28px;
                 line-height:1; cursor:pointer; z-index:1; }
        ${openRules(".tile:popover-open")}
        ${openRules(".tile.open")}
        .adaptive { position:absolute; inset:0; }
        .entity-view { position:absolute; inset:0; display:flex;
                       align-items:center; justify-content:center;
                       pointer-events:none; color:#fff; font-size:12px;
                       --ha-card-border-radius:0; --ha-card-box-shadow:none;
                       --ha-card-border-width:0; }
        .entity-view > * { display:block; width:100%; }
        .placeholder { position:absolute; inset:0; display:flex;
                       align-items:center; justify-content:center;
                       color:#bbb; font-size:12px; text-align:center; }
        .empty { padding:16px; color:var(--secondary-text-color); }
      </style>
      <div class="grid"></div>`;
    this._tiles = new Map();
    const grid = root.querySelector(".grid");
    if (!c.cameras.length) {
      grid.innerHTML = `<div class="empty">No cameras configured.</div>`;
      return;
    }
    for (const cam of c.cameras) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.setAttribute("popover", "manual");
      tile.appendChild(this._makeSource(cam));
      if (c.show_titles && cam.title) {
        const t = document.createElement("div");
        t.className = "title";
        t.textContent = cam.title;
        tile.appendChild(t);
      }
      const close = document.createElement("button");
      close.className = "close";
      close.setAttribute("aria-label", "Close");
      close.innerHTML = "&times;";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._closeOverlay();
      });
      tile.appendChild(close);
      tile.addEventListener("click", () => {
        if (this._open !== tile) this.focusCamera(this._id(cam));
      });
      cell.appendChild(tile);
      grid.appendChild(cell);
      this._tiles.set(this._id(cam), tile);
    }
    if (this.isConnected) for (const a of this._adaptive.values()) a.start();
  }

  focusCamera(id) {
    const tile = this._tiles?.get(id);
    if (!tile) return;
    this._closeOverlay();

    // The popover top layer lifts the tile above everything without
    // reparenting it; fall back to position:fixed where unsupported.
    if (typeof tile.showPopover === "function") tile.showPopover();
    else tile.classList.add("open");
    this._open = tile;
    this._openId = id;
    this._adaptive.get(id)?.setMode(this._config.fullscreen_quality);

    this._onKey = (e) => e.key === "Escape" && this._closeOverlay();
    window.addEventListener("keydown", this._onKey);

    const secs = Number(this._config.auto_close_seconds);
    if (secs > 0) {
      this._closeTimer = setTimeout(() => this._closeOverlay(), secs * 1000);
    }
  }

  _closeOverlay() {
    clearTimeout(this._closeTimer);
    if (this._onKey) window.removeEventListener("keydown", this._onKey);
    this._onKey = null;
    const tile = this._open;
    this._open = null;
    if (!tile) return;
    this._adaptive.get(this._openId)?.setMode(this._config.grid_quality);
    this._openId = null;
    tile.classList.remove("open");
    if (typeof tile.hidePopover === "function" && tile.matches(":popover-open")) {
      tile.hidePopover();
    }
  }
}

/* ---------- Visual editor ---------- */

const QUALITY_OPTIONS = [
  { value: "low", label: "Low only" },
  { value: "high", label: "Low first, then high" },
  { value: "auto", label: "Auto (falls back to low on poor network)" },
];

const EDITOR_SCHEMA = [
  { name: "go2rtc_url", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "columns", selector: { number: { min: 1, max: 8, mode: "box" } } },
      { name: "aspect_ratio", selector: { text: {} } },
      {
        name: "fit",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "cover", label: "Cover (crop)" },
              { value: "contain", label: "Contain (letterbox)" },
            ],
          },
        },
      },
      { name: "trigger_state", selector: { text: {} } },
      {
        name: "auto_close_seconds",
        selector: { number: { min: 0, max: 3600, mode: "box", unit_of_measurement: "s" } },
      },
      { name: "show_titles", selector: { boolean: {} } },
      { name: "grid_quality", selector: { select: { mode: "dropdown", options: QUALITY_OPTIONS } } },
      { name: "fullscreen_quality", selector: { select: { mode: "dropdown", options: QUALITY_OPTIONS } } },
      {
        name: "min_downlink_mbps",
        selector: { number: { min: 0, max: 50, step: 0.5, mode: "box", unit_of_measurement: "Mbit/s" } },
      },
    ],
  },
  {
    name: "cameras",
    selector: {
      object: {
        multiple: true,
        label_field: "title",
        fields: {
          title: { label: "Title", selector: { text: {} } },
          entity: {
            label: "Camera entity (instead of a go2rtc stream)",
            selector: { entity: { domain: "camera" } },
          },
          stream: { label: "go2rtc stream name (high quality)", selector: { text: {} } },
          stream_low: { label: "go2rtc low-quality stream (optional)", selector: { text: {} } },
          url: { label: "go2rtc URL (override)", selector: { text: {} } },
          id: { label: "ID (defaults to stream)", selector: { text: {} } },
          triggers: {
            label: "Trigger entities",
            selector: { entity: { multiple: true } },
          },
        },
      },
    },
  },
];

const EDITOR_LABELS = {
  go2rtc_url: "go2rtc base URL (default for all cameras)",
  columns: "Grid columns",
  aspect_ratio: "Tile aspect ratio",
  fit: "Video fit",
  trigger_state: "State that triggers full screen",
  auto_close_seconds: "Auto-close after (0 = manual only)",
  show_titles: "Show titles",
  grid_quality: "Quality in the grid",
  fullscreen_quality: "Quality in full screen",
  min_downlink_mbps: "Auto: minimum network speed for high (0 = ignore)",
  cameras: "Cameras",
};

class CameraGridCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: { ...ev.detail.value, type: this._config.type } },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = {
      columns: 2,
      aspect_ratio: "16:9",
      fit: "cover",
      trigger_state: "on",
      auto_close_seconds: 0,
      show_titles: true,
      ...this._config,
    };
  }
}

customElements.define("camera-grid-card", CameraGridCard);
customElements.define("camera-grid-card-editor", CameraGridCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "camera-grid-card",
  name: "Camera Grid Card",
  description: "go2rtc camera grid; a camera goes full screen when its trigger entity fires.",
  preview: false,
});

console.info(`%c CAMERA-GRID-CARD %c ${CARD_VERSION} `, "background:#03a9f4;color:#fff", "");
