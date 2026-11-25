"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Image from "next/image";
import {
  BarChart3,
  ImagePlus,
  LoaderCircle,
  PartyPopper,
  Send,
  X,
} from "lucide-react";
import { useCurrentUser } from "@/components/social/auth-guard";
import { UserAvatar } from "@/components/social/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EventLocationPicker, type EventLocation } from "@/components/social/event-location-picker";
import { ImageFileError, readImageAsDataUrl } from "@/lib/image-file";
import { apiRequest, type Tribe } from "@/lib/social-types";

interface FeedComposerProps {
  tribes: Tribe[];
  onPublished: () => Promise<void>;
}

const toolButton = "inline-flex size-9 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const MAX_TRIBE_LABEL_CHARACTERS = 17;

function getTribeButtonLabel(name?: string) {
  if (!name) return "Selecione a Tribo";

  const characters = Array.from(name);
  return characters.length > MAX_TRIBE_LABEL_CHARACTERS
    ? `${characters.slice(0, MAX_TRIBE_LABEL_CHARACTERS - 1).join("")}…`
    : name;
}

export function FeedComposer({ tribes, onPublished }: FeedComposerProps) {
  const { user } = useCurrentUser();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tribePickerRef = useRef<HTMLDivElement>(null);
  const [tribeId, setTribeId] = useState("");
  const [tribePickerOpen, setTribePickerOpen] = useState(false);
  const [body, setBody] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageError, setImageError] = useState("");
  const [creating, setCreating] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [eventMode, setEventMode] = useState(false);
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollMultiple, setPollMultiple] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventEndsAt, setEventEndsAt] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [eventLocationCoordinates, setEventLocationCoordinates] = useState<Pick<EventLocation, "lat" | "lon"> | null>(null);
  const [eventCost, setEventCost] = useState("");
  const [eventCapacity, setEventCapacity] = useState("");

  useEffect(() => {
    if (!tribePickerOpen) return;

    function handleOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !tribePickerRef.current?.contains(event.target)) {
        setTribePickerOpen(false);
      }
    }

    document.addEventListener("pointerdown", handleOutsideClick);
    return () => document.removeEventListener("pointerdown", handleOutsideClick);
  }, [tribePickerOpen]);

  const selectedTribe = tribes.find((tribe) => tribe.id === tribeId);
  const selectedTribeId = selectedTribe?.id ?? "";

  function resizeTextarea() {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  }

  function changeEventMode(nextMode: boolean) {
    setEventMode(nextMode);
    setPollMode(false);
    setComposerError("");
    setImageError("");
  }

  function changePollMode(nextMode: boolean) {
    setPollMode(nextMode);
    setEventMode(false);
    setComposerError("");
    setImageError("");
  }

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setImageError("");
    setComposerError("");
    if (!file) return;

    setImage(null);
    try {
      setImage(await readImageAsDataUrl(file));
    } catch (selectionError) {
      setImageError(selectionError instanceof ImageFileError && selectionError.code === "unsupported-type"
        ? "Escolha uma imagem JPEG, PNG ou WebP."
        : selectionError instanceof ImageFileError && selectionError.code === "too-large"
          ? "A imagem deve ter no máximo 5 MB."
          : "Não foi possível ler essa imagem.");
    } finally {
      event.target.value = "";
    }
  }

  async function submitContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTribeId) {
      setComposerError("Selecione uma tribo antes de publicar.");
      setTribePickerOpen(true);
      return;
    }
    if (!body.trim()) return;
    if (eventMode) {
      const startsAt = new Date(eventStartsAt);
      const endsAt = eventEndsAt ? new Date(eventEndsAt) : null;
      if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) {
        setComposerError("Informe uma data e um horário válidos para o evento.");
        return;
      }
      if (endsAt && endsAt <= startsAt) {
        setComposerError("A data de término deve ser posterior ao início.");
        return;
      }
    }
    setCreating(true);
    setComposerError("");
    try {
      if (pollMode) {
        await apiRequest(`/api/tribes/${selectedTribeId}/posts`, {
          method: "POST",
          body: JSON.stringify({ body, pollOptions: pollOptions.map((option) => option.trim()), pollMultiple, image: image ?? undefined }),
        });
      } else if (eventMode) {
        await apiRequest(`/api/tribes/${selectedTribeId}/events`, {
          method: "POST",
          body: JSON.stringify({
            body,
            title: eventTitle,
            startsAt: new Date(eventStartsAt).toISOString(),
            endsAt: eventEndsAt ? new Date(eventEndsAt).toISOString() : null,
            location: eventLocation,
            lat: eventLocationCoordinates?.lat ?? null,
            lon: eventLocationCoordinates?.lon ?? null,
            cost: eventCost,
            maxAttendees: eventCapacity ? Number(eventCapacity) : null,
            image: image ?? undefined,
          }),
        });
      } else {
        await apiRequest(`/api/tribes/${selectedTribeId}/posts`, {
          method: "POST",
          body: JSON.stringify({ body, image: image ?? undefined }),
        });
      }

      setBody("");
      setTribeId("");
      setTribePickerOpen(false);
      setPollOptions(["", ""]);
      setPollMultiple(false);
      setImage(null);
      setImageError("");
      setEventMode(false);
      setPollMode(false);
      setEventTitle("");
      setEventStartsAt("");
      setEventEndsAt("");
      setEventLocation("");
      setEventLocationCoordinates(null);
      setEventCost("");
      setEventCapacity("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      await onPublished();
    } catch (submitError) {
      setComposerError(submitError instanceof Error ? submitError.message : "Não foi possível publicar.");
    } finally {
      setCreating(false);
    }
  }

  const pollInvalid = pollMode && (
    pollOptions.some((option) => !option.trim())
    || new Set(pollOptions.map((option) => option.trim().toLocaleLowerCase("pt-BR"))).size !== pollOptions.length
  );

  const placeholder = eventMode
    ? "Conte um pouco sobre o evento..."
    : pollMode
      ? "Qual é a sua pergunta?"
      : "O que está acontecendo?";

  return (
    <form
      onSubmit={(event) => void submitContent(event)}
      className="w-full min-w-0 rounded-2xl border border-border bg-card p-4 shadow-xs sm:p-5"
    >
      <div className="flex items-start gap-3">
        <UserAvatar name={user.name} avatarUrl={user.avatarUrl} className="size-11" />
        <div className="relative min-w-0 flex-1">
          <div className="mb-1 flex justify-end">
            <Button type="submit" disabled={creating || !tribes.length || !selectedTribeId || !body.trim() || pollInvalid} className="h-8 min-h-8 gap-1 rounded-full px-2.5 text-[11px] leading-none sm:h-9 sm:min-h-9 sm:gap-1.5 sm:px-3 sm:text-xs lg:h-10 lg:min-h-10 lg:px-4 lg:text-sm">
            {creating ? <LoaderCircle className="size-3.5 shrink-0 animate-spin sm:size-4" /> : <Send className="size-3.5 shrink-0 sm:size-4" />}
            <span>Publicar</span>
            </Button>
          </div>
          <textarea
            ref={textareaRef}
            aria-label="Escreva sua publicação"
            placeholder={placeholder}
            value={body}
            rows={2}
            maxLength={5000}
            disabled={creating}
            onChange={(event) => { setBody(event.target.value); resizeTextarea(); }}
            className="block min-h-12 w-full resize-none border-0 bg-transparent py-2 text-lg leading-snug text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0"
          />

          {eventMode && <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
            <Input className="sm:col-span-2" aria-label="Título do evento" placeholder="Título do evento" value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} maxLength={120} required />
            <EventLocationPicker
              id="event-location"
              label="Local do evento"
              className="sm:col-span-2"
              value={eventLocation}
              coordinates={eventLocationCoordinates}
              onChange={(value, location) => {
                setEventLocation(value);
                setEventLocationCoordinates(location ? { lat: location.lat, lon: location.lon } : null);
              }}
            />
            <Input aria-label="Início do evento" type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} required />
            <Input aria-label="Término do evento" type="datetime-local" value={eventEndsAt} onChange={(event) => setEventEndsAt(event.target.value)} />
            <Input aria-label="Custo do evento" placeholder="Custo (opcional)" value={eventCost} onChange={(event) => setEventCost(event.target.value)} maxLength={100} />
            <Input aria-label="Limite de participantes" type="number" min="1" max="10000" placeholder="Limite de participantes" value={eventCapacity} onChange={(event) => setEventCapacity(event.target.value)} />
            <button type="button" disabled={creating} onClick={() => changeEventMode(false)} className="border-t border-border pt-3 text-center text-sm font-semibold text-destructive hover:underline disabled:opacity-50 sm:col-span-2">Remover evento</button>
          </div>}

          {pollMode && <div className="mt-2 space-y-2">
            <p className="text-sm font-semibold">Opções da enquete</p>
            {pollOptions.map((option, index) => <div key={index} className="flex gap-2">
              <Input aria-label={`Opção ${index + 1}`} placeholder={`Opção ${index + 1}`} value={option} maxLength={80} onChange={(event) => setPollOptions((current) => current.map((value, optionIndex) => optionIndex === index ? event.target.value : value))} />
              {pollOptions.length > 2 && <button type="button" aria-label={`Remover opção ${index + 1}`} onClick={() => setPollOptions((current) => current.filter((_, optionIndex) => optionIndex !== index))} className="rounded-lg px-3 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>}
            </div>)}
            {pollOptions.length < 6 && <button type="button" onClick={() => setPollOptions((current) => [...current, ""])} className="text-sm font-semibold text-primary hover:underline">Adicionar opção</button>}
            <label className="flex cursor-pointer items-center gap-2 border-t border-border pt-3 text-sm">
              <input type="checkbox" checked={pollMultiple} disabled={creating} onChange={(event) => setPollMultiple(event.target.checked)} className="size-4 accent-primary" />
              Permitir escolher várias opções
            </label>
            <button type="button" disabled={creating} onClick={() => changePollMode(false)} className="w-full border-t border-border pt-3 text-center text-sm font-semibold text-destructive hover:underline disabled:opacity-50">Remover enquete</button>
          </div>}

          {image && <div className="relative mt-2 w-fit max-w-full rounded-xl border border-border bg-muted/40 p-2">
            <Image src={image} alt="Pré-visualização da imagem" width={1200} height={900} unoptimized className="max-h-64 w-auto max-w-full rounded-lg object-contain" />
            <button type="button" aria-label="Remover imagem" onClick={() => { setImage(null); setImageError(""); }} className="absolute right-3 top-3 rounded-full bg-background/90 p-1.5 text-foreground shadow hover:bg-background"><X className="size-4" /></button>
          </div>}

          {imageError && <p role="alert" className="mt-2 text-sm text-destructive">{imageError}</p>}
          {!tribes.length && <p className="mt-2 text-sm text-muted-foreground">Entre em uma tribo antes de publicar.</p>}
          {composerError && <p role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{composerError}</p>}

          <div className="mt-3 flex flex-nowrap items-center gap-1.5 border-t border-border pt-3">
            <div className="relative -left-4 flex shrink-0 items-center gap-0">
              <label htmlFor="composer-image" title="Adicionar imagem" className={`${toolButton} cursor-pointer`}>
                <ImagePlus className="size-5" />
                <span className="sr-only">Adicionar imagem</span>
              </label>
              <input id="composer-image" type="file" accept="image/jpeg,image/png,image/webp" disabled={creating} onChange={(event) => void selectImage(event)} className="sr-only" />
              <button type="button" title="Criar enquete" aria-label="Criar enquete" aria-pressed={pollMode} disabled={creating} onClick={() => changePollMode(!pollMode)} className={`${toolButton} ${pollMode ? "bg-primary/10" : ""}`}>
                <BarChart3 className="size-5" />
              </button>
              <button type="button" title="Criar evento" aria-label="Criar evento" aria-pressed={eventMode} disabled={creating} onClick={() => changeEventMode(!eventMode)} className={`${toolButton} ${eventMode ? "bg-primary/10" : ""}`}>
                <PartyPopper className="size-5" />
              </button>
            </div>

            <div className="ml-auto flex w-fit min-w-0 justify-end">
              <div ref={tribePickerRef} className="relative w-[150px] max-w-[45vw] min-w-0">
                <div id="composer-tribe-options" hidden={!tribePickerOpen || !tribes.length} role="group" aria-label="Escolha uma tribo para publicar" className="absolute bottom-full right-0 z-30 mb-2 max-h-64 w-64 max-w-[calc(100vw-3rem)] overflow-y-auto rounded-xl border border-border bg-background p-3 shadow-lg">
                  <div className="flex flex-wrap gap-2">
                    {tribes.map((tribe) => <button
                      key={tribe.id}
                      type="button"
                      aria-pressed={selectedTribeId === tribe.id}
                      disabled={creating}
                      onClick={() => {
                        setTribeId(tribe.id);
                        setTribePickerOpen(false);
                        setComposerError("");
                      }}
                      className={`rounded-full border px-3 py-2 text-sm font-medium transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${selectedTribeId === tribe.id ? "border-primary bg-primary/10 text-primary" : "border-input bg-card"}`}
                    >
                      {tribe.name}
                    </button>)}
                  </div>
                </div>
                <Button
                  type="button"
                  aria-label={selectedTribe ? `Tribo selecionada: ${selectedTribe.name}. Alterar tribo` : "Selecionar tribo para publicar (obrigatório)"}
                  title={selectedTribe?.name}
                  aria-expanded={tribePickerOpen}
                  aria-controls="composer-tribe-options"
                  disabled={!tribes.length || creating}
                  onClick={() => {
                    setTribePickerOpen((open) => !open);
                    setComposerError("");
                  }}
                  className={`h-8 min-h-8 w-full min-w-0 gap-1 rounded-full px-1.5 text-[11px] leading-none sm:px-1.5 sm:text-[11px] ${tribePickerOpen || selectedTribe ? "ring-2 ring-primary/30" : ""}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-flame-kindling size-4 shrink-0 sm:size-4" aria-hidden="true">
                    <path d="M12 2c1 3 2.5 3.5 3.5 4.5A5 5 0 0 1 17 10a5 5 0 1 1-10 0c0-.3 0-.6.1-.9a2 2 0 1 0 3.3-2C8 4.5 11 2 12 2Z" />
                    <path d="m5 22 14-4" />
                    <path d="m5 18 14 4" />
                  </svg>
                  <span className="min-w-0 truncate">{getTribeButtonLabel(selectedTribe?.name)}</span>
                </Button>
              </div>

              
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
