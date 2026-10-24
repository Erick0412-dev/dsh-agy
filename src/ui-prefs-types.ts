export interface UiPrefsView {
  conversationBadge: boolean
  detailedQuotaReset: boolean
}

export interface SetUiPrefsPayload {
  conversationBadge?: boolean
  detailedQuotaReset?: boolean
}

export interface UiPrefsDocument {
  version: 1
  conversationBadge?: boolean
  detailedQuotaReset?: boolean
}
