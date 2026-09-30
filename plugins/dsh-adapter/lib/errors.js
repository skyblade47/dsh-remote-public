// @local/dsh-adapter —— 错误类型（§3.2/§4.2）
// AdapterError：fs/路径层；AdapterHttpError：HTTP 层。宿主 FsError 代码原样透传，仅追加 adapter 自己的代码。

export class AdapterError extends Error {
  constructor(code, message, cause) {
    super(message || code)
    this.name = 'AdapterError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export class AdapterHttpError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'AdapterHttpError'
    this.code = code
    if (extra) {
      if (extra.status !== undefined) this.status = extra.status
      if (extra.remoteError !== undefined) this.remoteError = extra.remoteError
      if (extra.body !== undefined) this.body = extra.body
    }
  }
}

// 宿主 FsError 代码透传映射（dsh-fs FSD L34-40）：FS_NOT_FOUND/FS_STALE_VERSION/FS_NOT_TEXT 等由宿主抛原码，
// adapter 侧 catch 时按 code 归类；此处仅注册 adapter 追加码的构造帮助。
export function isAdapterError(e) {
  return e instanceof AdapterError || e instanceof AdapterHttpError || (e && typeof e.code === 'string')
}
