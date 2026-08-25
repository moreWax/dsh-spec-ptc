"""Fresh-process Python CodeRuntime bootstrap; fd 3 is the host protocol channel."""
from __future__ import annotations
import asyncio, builtins, json, math, os, resource, sys, traceback

FD = 3
reader = os.fdopen(FD, "r", encoding="utf-8", buffering=1, closefd=False)
writer = os.fdopen(os.dup(FD), "w", encoding="utf-8", buffering=1)
next_id = 0


def send(message):
    writer.write(json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
    writer.flush()


def read():
    line = reader.readline()
    if not line:
        raise EOFError("host protocol channel closed")
    return json.loads(line)


class LogWriter:
    def __init__(self, limit):
        self.limit = limit
        self.used = 0
        self.closed = False
    def write(self, text):
        text = str(text)
        if not text or self.closed:
            return len(text)
        encoded = text.encode("utf-8")
        if self.used + len(encoded) <= self.limit:
            self.used += len(encoded); send({"type":"log","text":text}); return len(text)
        remain = max(0, self.limit - self.used)
        prefix = encoded[:remain].decode("utf-8", "ignore")
        if prefix:
            send({"type":"log","text":prefix})
        send({"type":"log","text":f"[dsh-code-runtime-python] log capture truncated at {self.limit} bytes","truncated":True})
        self.closed = True
        return len(text)
    def flush(self):
        writer.flush()


class BindingFunction:
    def __init__(self, global_name, name, error_cls, member_prop):
        self.global_name, self.name = global_name, name
        self.error_cls, self.member_prop = error_cls, member_prop
    async def __call__(self, args):
        global next_id
        call_id = next_id; next_id += 1
        send({"type":"call","id":call_id,"global":self.global_name,"name":self.name,"args":args})
        while True:
            reply = read()
            if reply.get("type") != "reply" or reply.get("id") != call_id:
                continue
            if reply.get("ok") is True:
                return reply.get("value")
            error = self.error_cls(reply.get("message", "binding failed"))
            if self.member_prop:
                setattr(error, self.member_prop, self.name)
            raise error


class Namespace:
    pass


def json_value(value):
    # Reject non-lossless values before encoding. json.dumps also rejects cycles.
    if isinstance(value, float) and (not math.isfinite(value) or math.copysign(1.0, value) < 0 and value == 0):
        raise ValueError("non-lossless number")
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        return [json_value(x) for x in value]
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return {k: json_value(v) for k, v in value.items()}
    raise ValueError("completion must be lossless JSON")


async def main():
    boot = read()
    if boot.get("type") != "boot":
        raise ValueError("expected boot")
    resource.setrlimit(resource.RLIMIT_CPU, (boot["cpuSeconds"], boot["cpuSeconds"]))
    resource.setrlimit(resource.RLIMIT_AS, (boot["addressSpaceBytes"], boot["addressSpaceBytes"]))
    globals_ns = {"__builtins__": builtins, "__name__": "__dsh_code__"}
    for descriptor in boot["namespaces"]:
        error_desc = descriptor.get("errorClass")
        error_cls = type(error_desc["name"], (Exception,), {}) if error_desc else RuntimeError
        if error_desc:
            globals_ns[error_desc["name"]] = error_cls
        namespace = Namespace()
        for name in descriptor["names"]:
            setattr(namespace, name, BindingFunction(descriptor["global"], name, error_cls, error_desc.get("memberNameProperty") if error_desc else None))
        globals_ns[descriptor["global"]] = namespace
    send({"type":"boot-ack"})
    run = read()
    if run.get("type") != "run": raise ValueError("expected run")
    program = run["program"]
    source = "async def __dsh_main__():\n" + "".join("    " + line for line in program.splitlines(keepends=True))
    if not program.endswith("\n"): source += "\n"
    exec(compile(source, "<dsh-code>", "exec"), globals_ns)
    log = LogWriter(boot["maxLogBytes"])
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = log
    try:
        value = await globals_ns["__dsh_main__"]()
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    if value is None:
        send({"type":"done"}); return
    try:
        clean = json_value(value)
        encoded = json.dumps(clean, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) > boot["maxValueBytes"]:
            send({"type":"done","error":{"kind":"output-limit","message":"completion exceeds value byte limit"}})
        else:
            send({"type":"done","value":clean})
    except Exception as error:
        send({"type":"done","error":{"kind":"invalid-output","message":str(error)}})


try:
    asyncio.run(main())
except BaseException:
    send({"type":"done","error":{"kind":"exception","message":traceback.format_exc()}})
