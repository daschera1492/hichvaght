'use strict';

/**
 * صفحهٔ اثرانگشت — این تابع با `Function.prototype.toString()` داخل صفحه
 * تزریق می‌شود، پس هیچ ارجاعی به دامنهٔ بیرونی (require / متغیر ماژول) ندارد.
 * هر چیزی که لازم دارد از `fp` می‌آید.
 *
 * کاری که می‌کند (همه‌اش با try/catch — هیچ‌وقت نباید ورود به صفحه را بشکند):
 *   • navigator.webdriver  → همیشه false
 *   • hardwareConcurrency / deviceMemory → مقدار تصادفیِ همان دستگاه
 *   • WebGL UNMASKED_VENDOR/RENDERER → کارت گرافیک واقعی‌نما (رانر GPU ندارد
 *     و مقدار اصلی SwiftShader است که خودش یک پرچم قرمز است)
 *   • canvas → نویز ±۳ روی کانال‌های RGB یک کپی (بوم اصلی دست‌نخورده می‌ماند)
 *   • AudioBuffer.getChannelData → نویز 2e-7 (هش صوتی هر اجرا فرق می‌کند)
 *   • Function.prototype.toString → توابع پچ‌شده «native» دیده می‌شوند
 */
function installFp(fp) {
  try {
    var define = function (proto, name, value) {
      try {
        Object.defineProperty(proto, name, {
          configurable: true,
          get: function () {
            return value;
          }
        });
      } catch (e) {}
    };

    // ---------------------------------------------------------------- navigator
    define(Navigator.prototype, 'webdriver', false);
    if (fp.hardwareConcurrency) {
      define(Navigator.prototype, 'hardwareConcurrency', fp.hardwareConcurrency);
    }
    if (fp.deviceMemory) {
      define(Navigator.prototype, 'deviceMemory', fp.deviceMemory);
    }

    // ------------------------------------------------------------------- screen
    // رانر گیت‌هاب یک نمایشگر ۱۰۲۴×۷۶۸ دارد ولی پنجرهٔ GmailDuck ۱۱۲۰×۸۶۰ است —
    // یعنی ویوپورت از خودِ صفحهٔ نمایش بزرگ‌تر می‌شود؛ چیزی که در دنیای واقعی
    // ممکن نیست و هر اثرانگشت‌گیرِ ساده‌ای (از جمله browserinfo گوگل) می‌بیند.
    // این‌جا اندازهٔ نمایشگر روی یک رزولوشن معمولی و بزرگ‌تر از پنجره ست می‌شود،
    // تا screen ≥ outer ≥ inner شود.
    if (fp.screen && fp.screen.length === 2) {
      var sw = fp.screen[0];
      var sh = fp.screen[1];
      var S = window.Screen && Screen.prototype;
      if (S) {
        define(S, 'width', sw);
        define(S, 'height', sh);
        define(S, 'availWidth', sw);
        define(S, 'availHeight', Math.max(600, sh - 40)); // نوار وظیفهٔ ویندوز
        define(S, 'availLeft', 0);
        define(S, 'availTop', 0);
        define(S, 'colorDepth', 24);
        define(S, 'pixelDepth', 24);
      }
    }

    // ------------------------------------- توابع پچ‌شده نباید «سورس» لو بدهند
    var nativeToString = Function.prototype.toString;
    var masked = new WeakMap();
    Function.prototype.toString = function () {
      try {
        var name = masked.get(this);
        if (name) return 'function ' + name + '() { [native code] }';
      } catch (e) {}
      return nativeToString.call(this);
    };
    var mask = function (fn, name) {
      try {
        masked.set(fn, name);
      } catch (e) {}
      return fn;
    };

    // ------------------------------------------------------------------- WebGL
    var patchGl = function (Ctor) {
      if (!Ctor || !Ctor.prototype || !Ctor.prototype.getParameter) return;
      var orig = Ctor.prototype.getParameter;
      Ctor.prototype.getParameter = mask(function (p) {
        if (p === 37445) return fp.webglVendor;
        if (p === 37446) return fp.webglRenderer;
        return orig.apply(this, arguments);
      }, 'getParameter');
    };
    patchGl(window.WebGLRenderingContext);
    patchGl(window.WebGL2RenderingContext);

    // ------------------------------------------------------------------ WebGPU
    // WebGL می‌گوید «کارت NVIDIA» ولی WebGPU همان SwiftShader را نشان می‌دهد؟
    // این تناقض از خودِ WebGL بدتر است. اطلاعات آداپتور هم‌خوان می‌شود.
    try {
      if (fp.webgpuVendor && window.GPU && GPU.prototype && GPU.prototype.requestAdapter) {
        var origAdapter = GPU.prototype.requestAdapter;
        GPU.prototype.requestAdapter = mask(function () {
          var p = origAdapter.apply(this, arguments);
          if (!p || typeof p.then !== 'function') return p;
          return p.then(function (adapter) {
            try {
              var info = adapter && adapter.info;
              if (info) {
                var put = function (name, value) {
                  try {
                    Object.defineProperty(info, name, {
                      configurable: true,
                      enumerable: true,
                      get: function () {
                        return value;
                      }
                    });
                  } catch (e) {}
                };
                put('vendor', fp.webgpuVendor);
                put('architecture', fp.webgpuArch || '');
              }
            } catch (e) {}
            return adapter;
          });
        }, 'requestAdapter');
      }
    } catch (e) {}

    // ------------------------------------------------------------------ canvas
    // نویز روی یک کپی اعمال می‌شود تا بوم اصلی (و رندر واقعی صفحه) دست‌نخورده
    // بماند؛ خروجی toDataURL/toBlob همان چیزی است که اثرانگشت‌گیر می‌خواند.
    var noisyCopy = function (source, w, h) {
      if (!w || !h || w * h > 1048576) return null;
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0);
      var img = ctx.getImageData(0, 0, w, h);
      var d = img.data;
      var s = fp.canvasSeed >>> 0;
      for (var i = 0; i < d.length; i += 4) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        d[i] = Math.max(0, Math.min(255, d[i] + ((s & 7) - 3)));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + (((s >> 3) & 7) - 3)));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + (((s >> 6) & 7) - 3)));
      }
      ctx.putImageData(img, 0, 0);
      return c;
    };

    if (window.HTMLCanvasElement && HTMLCanvasElement.prototype.toDataURL) {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = mask(function () {
        try {
          var copy = noisyCopy(this, this.width, this.height);
          if (copy) return origToDataURL.apply(copy, arguments);
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      }, 'toDataURL');
    }

    if (window.HTMLCanvasElement && HTMLCanvasElement.prototype.toBlob) {
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = mask(function () {
        try {
          var copy = noisyCopy(this, this.width, this.height);
          if (copy) return origToBlob.apply(copy, arguments);
        } catch (e) {}
        return origToBlob.apply(this, arguments);
      }, 'toBlob');
    }

    // ------------------------------------------------------------------- audio
    if (window.AudioBuffer && AudioBuffer.prototype && AudioBuffer.prototype.getChannelData) {
      var origChannel = AudioBuffer.prototype.getChannelData;
      var audioSeed = fp.audioSeed >>> 0;
      AudioBuffer.prototype.getChannelData = mask(function (channel) {
        var data = origChannel.call(this, channel);
        try {
          var out = new Float32Array(data.length);
          var s = (audioSeed + (channel | 0) * 2654435761) >>> 0;
          for (var i = 0; i < data.length; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            out[i] = data[i] + (s / 4294967296 - 0.5) * 2e-7;
          }
          return out;
        } catch (e) {
          return data;
        }
      }, 'getChannelData');
    }
  } catch (e) {
    /* هیچ‌وقت صفحه را نشکن */
  }
}

module.exports = installFp;
