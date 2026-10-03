"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkles, Loader2, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react"
import { getAIConfig, setAIConfig, type AIConfig, type AIConfigInput } from "@/lib/api"

const DEFAULT_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
}

export function AiPanel() {
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [provider, setProvider] = useState("anthropic")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [keyInput, setKeyInput] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const applyConfig = useCallback((c: AIConfig) => {
    setConfig(c)
    setProvider(c.provider || "anthropic")
    setBaseUrl(c.base_url || "")
    setModel(c.model || "")
  }, [])

  useEffect(() => {
    let cancelled = false
    getAIConfig()
      .then((c) => {
        if (!cancelled) applyConfig(c)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Impossible de charger la configuration IA")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyConfig])

  const run = async (input: AIConfigInput, okMsg: string) => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const c = await setAIConfig(input)
      applyConfig(c)
      setKeyInput("")
      setMessage(okMsg)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur lors de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  const handleSave = () =>
    run(
      { provider, base_url: baseUrl.trim() || undefined, model: model.trim(), api_key: keyInput || undefined },
      "Configuration enregistrée"
    )

  const handleClearKey = () =>
    run({ provider, base_url: baseUrl.trim() || undefined, model: model.trim(), clear_key: true }, "Clé effacée")

  const endpointChanged =
    !!config && config.has_key && !keyInput && (provider !== config.provider || baseUrl.trim() !== (config.base_url || ""))
  const shownUrl = baseUrl.trim() || DEFAULT_URLS[provider] || "le fournisseur configuré"

  return (
    <Card className="mx-auto w-full max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Analyse IA
        </CardTitle>
        <CardDescription>Fournisseur LLM utilisé pour l&apos;analyse CAN assistée.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement...
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="ai-provider">Fournisseur</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="ai-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-base-url">URL de base</Label>
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.anthropic.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model">Modèle</Label>
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-opus-5-5"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="ai-key">Clé API</Label>
                {config?.has_key && (
                  <span className="flex items-center gap-1 text-sm text-green-600">
                    <CheckCircle2 className="h-4 w-4" /> Clé configurée ✓
                  </span>
                )}
              </div>
              <Input
                id="ai-key"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={config?.has_key ? "Laisser vide pour conserver la clé actuelle" : "Saisir la clé API"}
                autoComplete="new-password"
              />
            </div>

            {endpointChanged && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Changer le fournisseur ou l&apos;URL efface la clé stockée, sauf si vous en saisissez une nouvelle.
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {message && !error && (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={handleSave} disabled={saving || !model.trim()} className="w-full sm:w-auto">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Enregistrer
              </Button>
              {config?.has_key && (
                <Button variant="outline" onClick={handleClearKey} disabled={saving} className="w-full sm:w-auto">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Effacer la clé
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Les données d&apos;analyse quittent le Pi vers {shownUrl}. Nécessite internet. La clé est stockée sur le
              Pi, jamais renvoyée.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
