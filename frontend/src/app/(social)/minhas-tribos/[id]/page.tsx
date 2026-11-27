"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, LoaderCircle, Save, ShieldCheck, Trash2, Unlink, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INTEREST_CATEGORIES } from "@/lib/tribes-data";
import { apiRequest, type Tribe } from "@/lib/social-types";

type SocialPartnerLink = {
  id: string;
  partnerId: string;
  applicationId: string;
  partnerTribeId: string;
  externalTribeId: string;
  partnerSlug: string;
  partnerName: string;
  applicationSlug: string;
  applicationName: string;
  authorizedBy: string;
  authorizedByName: string;
  authorizedAt: string;
  privateAtAuthorization: boolean;
  privateDataConsent: boolean;
  revokedBy: string | null;
  revokedByName: string | null;
  revokedAt: string | null;
  revocationSource: string | null;
  active: boolean;
};

type TribeMember = { id: string; name: string; isModerator: boolean };
type SocialPartnerGrant = {
  id: string;
  applicationId: string;
  partnerTribeId: string;
  externalTribeId: string;
  beneficiaryUserId: string;
  capability: "organizer.manage";
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revocationSource: string | null;
  active: boolean;
};

type SocialPartnerLinkPreview = {
  confirmationToken: string;
  expiresAt: string;
  partner: { id: string; slug: string; name: string };
  application: { id: string; slug: string; name: string };
  partnerTribe: { id: string; externalTribeId: string; name: string };
  socialTribe: { id: string; name: string; isPrivate: boolean };
};

export default function EditMyTribePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [tribe, setTribe] = useState<Tribe | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [format, setFormat] = useState<Tribe["format"]>("Presencial");
  const [city, setCity] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  const [deleteConfirmationName, setDeleteConfirmationName] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [partnerLinks, setPartnerLinks] = useState<SocialPartnerLink[]>([]);
  const [partnerGrants, setPartnerGrants] = useState<SocialPartnerGrant[]>([]);
  const [tribeMembers, setTribeMembers] = useState<TribeMember[]>([]);
  const [partnerLinksLoading, setPartnerLinksLoading] = useState(false);
  const [partnerLinksError, setPartnerLinksError] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [externalTribeId, setExternalTribeId] = useState("");
  const [linkPreview, setLinkPreview] = useState<SocialPartnerLinkPreview | null>(null);
  const [confirmPrivateSharing, setConfirmPrivateSharing] = useState(false);
  const [linkWorking, setLinkWorking] = useState(false);
  const [grantApplicationId, setGrantApplicationId] = useState("");
  const [grantExternalTribeId, setGrantExternalTribeId] = useState("");
  const [grantBeneficiaryUserId, setGrantBeneficiaryUserId] = useState("");
  const [grantWorking, setGrantWorking] = useState(false);

  const loadPartnerLinks = useCallback(async () => {
    setPartnerLinksLoading(true);
    setPartnerLinksError("");
    try {
      const [links, grants, members] = await Promise.all([
        apiRequest<{ links: SocialPartnerLink[] }>(`/api/tribes/${id}/partner-links`, { cache: "no-store" }),
        apiRequest<{ grants: SocialPartnerGrant[] }>(`/api/tribes/${id}/partner-grants`, { cache: "no-store" }),
        apiRequest<{ members: TribeMember[] }>(`/api/tribes/${id}/members`, { cache: "no-store" }),
      ]);
      setPartnerLinks(links.links);
      setPartnerGrants(grants.grants);
      setTribeMembers(members.members);
    } catch (loadError) {
      setPartnerLinksError(loadError instanceof Error ? loadError.message : "Não foi possível carregar os vínculos de parceiros.");
    } finally {
      setPartnerLinksLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    apiRequest<{ tribes: Tribe[] }>("/api/tribes?managed=true")
      .then(({ tribes }) => {
        if (!active) return;
        const current = tribes.find((item) => item.id === id && item.isModerator);
        if (!current) {
          setError("Esta tribo não existe ou você não tem permissão para editá-la.");
          return;
        }
        setTribe(current);
        setName(current.name);
        setDescription(current.description);
        setCategory(current.category);
        setFormat(current.format);
        setCity(current.city);
        setNeighborhood(current.neighborhood);
        void loadPartnerLinks();
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar a tribo.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, loadPartnerLinks]);

  async function previewPartnerLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLinkWorking(true);
    setPartnerLinksError("");
    setLinkPreview(null);
    setConfirmPrivateSharing(false);
    try {
      const preview = await apiRequest<SocialPartnerLinkPreview>(`/api/tribes/${id}/partner-links/preview`, {
        method: "POST", body: JSON.stringify({ applicationId, externalTribeId }),
      });
      setLinkPreview(preview);
    } catch (previewError) {
      setPartnerLinksError(previewError instanceof Error ? previewError.message : "Não foi possível gerar a prévia do vínculo.");
    } finally {
      setLinkWorking(false);
    }
  }

  async function confirmPartnerLink() {
    if (!linkPreview) return;
    setLinkWorking(true);
    setPartnerLinksError("");
    try {
      await apiRequest(`/api/tribes/${id}/partner-links/confirm`, {
        method: "POST",
        body: JSON.stringify({ confirmationToken: linkPreview.confirmationToken, confirmPrivateSharing }),
      });
      setLinkPreview(null);
      setApplicationId("");
      setExternalTribeId("");
      setConfirmPrivateSharing(false);
      await loadPartnerLinks();
    } catch (confirmError) {
      setPartnerLinksError(confirmError instanceof Error ? confirmError.message : "Não foi possível confirmar o vínculo.");
    } finally {
      setLinkWorking(false);
    }
  }

  async function revokePartnerLink(link: SocialPartnerLink) {
    setLinkWorking(true);
    setPartnerLinksError("");
    try {
      await apiRequest(
        `/api/tribes/${id}/partner-links/${encodeURIComponent(link.applicationId)}/${encodeURIComponent(link.externalTribeId)}`,
        { method: "DELETE" },
      );
      await loadPartnerLinks();
    } catch (revokeError) {
      setPartnerLinksError(revokeError instanceof Error ? revokeError.message : "Não foi possível revogar o vínculo.");
    } finally {
      setLinkWorking(false);
    }
  }

  async function issueOrganizerGrant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGrantWorking(true);
    setPartnerLinksError("");
    try {
      await apiRequest(`/api/tribes/${id}/partner-grants`, {
        method: "POST",
        body: JSON.stringify({
          applicationId: grantApplicationId,
          externalTribeId: grantExternalTribeId,
          beneficiaryUserId: grantBeneficiaryUserId,
        }),
      });
      setGrantApplicationId("");
      setGrantExternalTribeId("");
      setGrantBeneficiaryUserId("");
      await loadPartnerLinks();
    } catch (grantError) {
      setPartnerLinksError(grantError instanceof Error ? grantError.message : "Não foi possível designar o organizador.");
    } finally {
      setGrantWorking(false);
    }
  }

  async function revokeOrganizerGrant(grant: SocialPartnerGrant) {
    setGrantWorking(true);
    setPartnerLinksError("");
    try {
      await apiRequest(`/api/tribes/${id}/partner-grants/${encodeURIComponent(grant.id)}`, { method: "DELETE" });
      await loadPartnerLinks();
    } catch (grantError) {
      setPartnerLinksError(grantError instanceof Error ? grantError.message : "Não foi possível revogar o grant.");
    } finally {
      setGrantWorking(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await apiRequest<{ tribe: Tribe }>(`/api/tribes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description, category, format, city, neighborhood }),
      });
      setTribe(result.tribe);
      router.push(`/tribos/${id}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar as alterações.");
    } finally {
      setSaving(false);
    }
  }

  function closeDeleteDialog(open: boolean) {
    setDeleteDialogOpen(open);
    if (!open) {
      setDeleteStep(1);
      setDeleteConfirmationName("");
      setDeleteError("");
    }
  }

  async function deleteTribe() {
    if (!tribe || deleteConfirmationName.trim() !== tribe.name) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiRequest<{ ok: boolean }>(`/api/tribes/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmationName: tribe.name }),
      });
      router.push("/minhas-tribos");
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : "Não foi possível excluir a tribo.");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <main className="flex justify-center py-20"><LoaderCircle className="size-6 animate-spin text-primary" /></main>;

  return (
    <main className="mx-auto max-w-2xl space-y-5">
      <Link href="/minhas-tribos" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Voltar para minhas tribos</Link>
      <section className="rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
        <Badge className="bg-primary/10 text-primary"><Users className="size-3" />Gestão da comunidade</Badge>
        <h1 className="mt-3 font-heading text-2xl font-extrabold">Editar tribo</h1>
        <p className="mt-1 text-sm text-muted-foreground">Atualize as informações que aparecem para quem encontra sua comunidade.</p>
        {tribe && (
          <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4">
            <div className="space-y-1.5"><Label htmlFor="tribe-name">Nome</Label><Input id="tribe-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} minLength={2} maxLength={80} required /></div>
            <div className="space-y-1.5"><Label htmlFor="tribe-description">Descrição</Label><Textarea id="tribe-description" value={description} onChange={(event) => { setDescription(event.target.value); setSaved(false); }} minLength={2} maxLength={1000} rows={5} required /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="tribe-category">Categoria</Label><select id="tribe-category" value={category} onChange={(event) => { setCategory(event.target.value); setSaved(false); }} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">{INTEREST_CATEGORIES.map((item) => <option key={item.id} value={item.label}>{item.label}</option>)}</select></div>
              <div className="space-y-1.5"><Label htmlFor="tribe-format">Formato</Label><select id="tribe-format" value={format} onChange={(event) => { setFormat(event.target.value as Tribe["format"]); setSaved(false); }} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option>Presencial</option><option>Híbrido</option><option>Online</option></select></div>
              <div className="space-y-1.5"><Label htmlFor="tribe-city">Cidade</Label><Input id="tribe-city" value={city} onChange={(event) => { setCity(event.target.value); setSaved(false); }} minLength={2} maxLength={100} required /></div>
              <div className="space-y-1.5"><Label htmlFor="tribe-neighborhood">Bairro</Label><Input id="tribe-neighborhood" value={neighborhood} onChange={(event) => { setNeighborhood(event.target.value); setSaved(false); }} maxLength={100} placeholder="Opcional" /></div>
            </div>
            {error && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {saved && <p role="status" className="text-sm font-medium text-primary">Alterações salvas com sucesso.</p>}
            <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="destructive" disabled={saving || deleting} onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="size-4" />Excluir tribo
              </Button>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" nativeButton={false} render={<Link href={`/tribos/${id}`} />}>Cancelar</Button>
                <Button type="submit" disabled={saving || name.trim().length < 2 || description.trim().length < 2 || city.trim().length < 2}>
                  {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                  {saving ? "Salvando..." : "Salvar alterações"}
                </Button>
              </div>
            </div>
          </form>
        )}
        {!tribe && error && <p role="alert" className="mt-5 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </section>
      {tribe && <section className="space-y-5 rounded-3xl border border-border bg-card p-5 shadow-xs sm:p-8">
        <div>
          <Badge variant="outline"><ShieldCheck className="size-3" />Autorizações de parceiros</Badge>
          <h2 className="mt-3 font-heading text-xl font-bold">Vínculos com integrações</h2>
          <p className="mt-1 text-sm text-muted-foreground">Somente você, como moderador autenticado, pode autorizar ou revogar o acesso de uma aplicação aos metadados desta tribo.</p>
        </div>
        <form onSubmit={(event) => void previewPartnerLink(event)} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5"><Label htmlFor="partner-application-id">ID da aplicação parceira</Label><Input id="partner-application-id" value={applicationId} onChange={(event) => setApplicationId(event.target.value)} required maxLength={36} placeholder="UUID da aplicação" /></div>
          <div className="space-y-1.5"><Label htmlFor="partner-external-tribe-id">Identificador externo da tribo</Label><Input id="partner-external-tribe-id" value={externalTribeId} onChange={(event) => setExternalTribeId(event.target.value)} required maxLength={128} /></div>
          <Button type="submit" disabled={linkWorking || !applicationId.trim() || !externalTribeId.trim()}>
            {linkWorking ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Ver prévia
          </Button>
        </form>
        {linkPreview && <div className="space-y-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <h3 className="font-semibold">Confirme o vínculo solicitado</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Parceiro</dt><dd className="font-medium">{linkPreview.partner.name} ({linkPreview.partner.slug})</dd></div>
            <div><dt className="text-muted-foreground">Aplicação</dt><dd className="font-medium">{linkPreview.application.name} ({linkPreview.application.slug})</dd></div>
            <div><dt className="text-muted-foreground">Recurso do parceiro</dt><dd className="font-medium">{linkPreview.partnerTribe.name} · {linkPreview.partnerTribe.externalTribeId}</dd></div>
            <div><dt className="text-muted-foreground">Sua tribo</dt><dd className="font-medium">{linkPreview.socialTribe.name}</dd></div>
          </dl>
          <p className="text-sm text-muted-foreground">Ao autorizar, esta aplicação poderá consultar os metadados atuais da tribo e associar a ela eventos provisionais. Isso não altera a moderação nem publica conteúdo no feed.</p>
          {linkPreview.socialTribe.isPrivate && <label className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <input type="checkbox" checked={confirmPrivateSharing} onChange={(event) => setConfirmPrivateSharing(event.target.checked)} className="mt-1" />
            <span>Confirmo que quero compartilhar os metadados desta tribo privada com o parceiro e a aplicação identificados acima.</span>
          </label>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={linkWorking || (linkPreview.socialTribe.isPrivate && !confirmPrivateSharing)} onClick={() => void confirmPartnerLink()}>
              {linkWorking && <LoaderCircle className="size-4 animate-spin" />}Autorizar vínculo
            </Button>
            <Button type="button" variant="outline" disabled={linkWorking} onClick={() => { setLinkPreview(null); setConfirmPrivateSharing(false); }}>Cancelar</Button>
          </div>
        </div>}
        {partnerLinksError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{partnerLinksError}</p>}
        {partnerLinksLoading && <div className="flex justify-center py-4"><LoaderCircle className="size-5 animate-spin text-primary" /></div>}
        {!partnerLinksLoading && partnerLinks.length > 0 && <div className="space-y-2">
          <h3 className="text-sm font-semibold">Histórico de autorizações</h3>
          {partnerLinks.map((link) => <div key={link.id} className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-semibold">{link.partnerName} · {link.applicationName}</p>
              <p className="break-all text-muted-foreground">ID externo: {link.externalTribeId}</p>
              <p className="text-xs text-muted-foreground">Autorizado por {link.authorizedByName} · {new Date(link.authorizedAt).toLocaleString("pt-BR")}</p>
              {link.revokedAt && <p className="text-xs text-muted-foreground">Revogado por {link.revokedByName ?? "exclusão da tribo"} · {new Date(link.revokedAt).toLocaleString("pt-BR")}</p>}
              {link.privateAtAuthorization && <p className="text-xs text-amber-700">Consentimento para metadados privados registrado.</p>}
            </div>
            {link.active && <Button type="button" variant="outline" disabled={linkWorking} onClick={() => void revokePartnerLink(link)}>
              {linkWorking ? <LoaderCircle className="size-4 animate-spin" /> : <Unlink className="size-4" />}Revogar
            </Button>}
          </div>)}
        </div>}
        {!partnerLinksLoading && partnerLinks.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há vínculos autorizados.</p>}
        <div className="space-y-3 border-t border-border pt-5">
          <div>
            <h3 className="font-semibold">Designações de organizadores</h3>
            <p className="mt-1 text-sm text-muted-foreground">Designa um membro ativo como organizador humano de um recurso provisional já vinculado. Isso não concede permissões de edição, moderação ou publicação na Tribes.</p>
          </div>
          <form onSubmit={(event) => void issueOrganizerGrant(event)} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="grant-application-id">ID da aplicação</Label><Input id="grant-application-id" value={grantApplicationId} onChange={(event) => setGrantApplicationId(event.target.value)} required maxLength={36} placeholder="UUID da aplicação" /></div>
            <div className="space-y-1.5"><Label htmlFor="grant-external-tribe-id">Identificador externo da tribo</Label><Input id="grant-external-tribe-id" value={grantExternalTribeId} onChange={(event) => setGrantExternalTribeId(event.target.value)} required maxLength={128} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="grant-beneficiary">Membro designado</Label><select id="grant-beneficiary" value={grantBeneficiaryUserId} onChange={(event) => setGrantBeneficiaryUserId(event.target.value)} required className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option value="">Selecione um membro ativo</option>{tribeMembers.map((member) => <option key={member.id} value={member.id}>{member.name}{member.isModerator ? " (moderador)" : ""}</option>)}</select></div>
            <div className="sm:col-span-2"><Button type="submit" disabled={grantWorking || !grantApplicationId.trim() || !grantExternalTribeId.trim() || !grantBeneficiaryUserId}>{grantWorking && <LoaderCircle className="size-4 animate-spin" />}Designar organizador</Button></div>
          </form>
          {partnerGrants.length > 0 ? <div className="space-y-2">
            <h4 className="text-sm font-semibold">Histórico de designações</h4>
            {partnerGrants.map((grant) => {
              const memberName = tribeMembers.find((member) => member.id === grant.beneficiaryUserId)?.name;
              return <div key={grant.id} className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold">{memberName ?? `Membro ${grant.beneficiaryUserId.slice(0, 8)}`} · {grant.externalTribeId}</p>
                  <p className="text-xs text-muted-foreground">Designado em {new Date(grant.grantedAt).toLocaleString("pt-BR")} · organizer.manage</p>
                  {grant.revokedAt && <p className="text-xs text-muted-foreground">Revogado em {new Date(grant.revokedAt).toLocaleString("pt-BR")} ({grant.revocationSource})</p>}
                </div>
                {grant.active && <Button type="button" variant="outline" disabled={grantWorking} onClick={() => void revokeOrganizerGrant(grant)}>{grantWorking ? <LoaderCircle className="size-4 animate-spin" /> : <Unlink className="size-4" />}Revogar designação</Button>}
              </div>;
            })}
          </div> : !partnerLinksLoading && <p className="text-sm text-muted-foreground">Ainda não há designações de organizadores.</p>}
        </div>
      </section>}
      <Dialog open={deleteDialogOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent>
          {deleteStep === 1 ? <>
            <DialogHeader>
              <DialogTitle>Excluir tribo permanentemente?</DialogTitle>
              <DialogDescription>Essa ação excluirá a tribo “{tribe?.name}”, seus membros, publicações, eventos e notificações. Ela não poderá ser desfeita.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => closeDeleteDialog(false)}>Cancelar</Button>
              <Button type="button" variant="destructive" onClick={() => { setDeleteStep(2); setDeleteError(""); }}>Continuar</Button>
            </DialogFooter>
          </> : <>
            <DialogHeader>
              <DialogTitle>Confirme a exclusão</DialogTitle>
              <DialogDescription>Para concluir, digite o nome exato da tribo: <strong className="break-all text-foreground">{tribe?.name}</strong>.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="delete-tribe-name">Nome da tribo</Label>
              <Input id="delete-tribe-name" value={deleteConfirmationName} onChange={(event) => setDeleteConfirmationName(event.target.value)} autoComplete="off" />
            </div>
            {deleteError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{deleteError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={deleting} onClick={() => closeDeleteDialog(false)}>Cancelar</Button>
              <Button type="button" variant="destructive" disabled={deleting || deleteConfirmationName.trim() !== tribe?.name} onClick={() => void deleteTribe()}>
                {deleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                {deleting ? "Excluindo..." : "Excluir definitivamente"}
              </Button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </main>
  );
}
