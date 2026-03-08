
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Users, Key, Shield, Plus, Search, Fingerprint, Mail, Smartphone,
    Globe, Trash2, Copy, CheckCircle2, AlertCircle, Loader2, X,
    UserPlus, CreditCard, Hash, Settings, Eye, EyeOff, Lock, Ban,
    Filter, ChevronLeft, ChevronRight, CheckSquare, Square, Link,
    Clock, Zap, Github, Facebook, Twitter, Edit2, Unlink, Layers,
    RefreshCcw, ArrowRight, LayoutTemplate, Send, ShieldAlert, Target,
    MessageSquare, Server, Plug, BellRing, PartyPopper, Code
} from 'lucide-react';

const AuthConfig: React.FC<{ projectId: string }> = ({ projectId }) => {
    const [activeSection, setActiveSection] = useState<'users' | 'strategies' | 'messaging' | 'security' | 'apps' | 'schema'>('users');

    // DIRECTORY STATE
    const [users, setUsers] = useState<any[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [isSensitiveVisible, setIsSensitiveVisible] = useState(false);
    const [showVerifyModal, setShowVerifyModal] = useState(false);
    const [verifyPassword, setVerifyPassword] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'date' | 'alpha'>('date');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    // USER DETAIL MODAL
    const [selectedUser, setSelectedUser] = useState<any>(null);
    const [showUserModal, setShowUserModal] = useState(false);
    const [deleteConfirmUuid, setDeleteConfirmUuid] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState<any>(null);
    const [activeSessions, setActiveSessions] = useState<any[]>([]);
    const [loadingSessions, setLoadingSessions] = useState(false);

    // LINK IDENTITY STATE
    const [showLinkIdentity, setShowLinkIdentity] = useState(false);
    const [linkIdentityForm, setLinkIdentityForm] = useState({ provider: 'email', identifier: '', password: '' });

    // CONFIGURATION STATE
    const [strategies, setStrategies] = useState<any>({});
    const [globalOrigins, setGlobalOrigins] = useState<string[]>([]);
    const [siteUrl, setSiteUrl] = useState(''); // Default Redirect
    const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
    const [strategyConfig, setStrategyConfig] = useState<any>(null);
    const [editingStrategyName, setEditingStrategyName] = useState('');
    const [showConfigModal, setShowConfigModal] = useState(false);

    // SECURITY / SMART LOCKOUT STATE
    const [securityConfig, setSecurityConfig] = useState({
        max_attempts: 5,
        lockout_minutes: 15,
        strategy: 'hybrid' // 'ip' | 'identifier' | 'hybrid' | 'email'
    });

    // EMAIL CENTER STATE (New Architecture)
    const [emailTab, setEmailTab] = useState<'gateway' | 'templates' | 'library' | 'policies'>('gateway');

    // 1. Gateway Config (SMTP/Resend)
    const [emailGateway, setEmailGateway] = useState<any>({
        delivery_method: 'resend', // 'smtp' | 'resend' | 'webhook'
        from_email: 'noreply@cascata.io',
        resend_api_key: '',
        smtp_host: '',
        smtp_port: 587,
        smtp_user: '',
        smtp_pass: '',
        smtp_secure: false,
        webhook_url: ''
    });

    // 2. Templates Config
    const [emailTemplates, setEmailTemplates] = useState<any>({
        confirmation: { subject: 'Confirm Your Email', body: '<h2>Confirm your email</h2><p>Click the link below to confirm your email address:</p><p><a href="{{ .ConfirmationURL }}">Confirm Email</a></p>' },
        recovery: { subject: 'Reset Your Password', body: '<h2>Reset Password</h2><p>Click here to reset your password:</p><a href="{{ .ConfirmationURL }}">Reset Password</a>' },
        magic_link: { subject: 'Your Login Link', body: '<h2>Login Request</h2><p>Click here to login:</p><a href="{{ .ConfirmationURL }}">Sign In</a>' },
        login_alert: { subject: 'New Login Detected', body: '<h2>New Login</h2><p>We detected a new login to your account at {{ .Date }}.</p>' },
        welcome_email: { subject: 'Welcome!', body: '<h2>Welcome to our platform!</h2><p>We are glad to have you with us.</p>' }
    });
    const [activeTemplateTab, setActiveTemplateTab] = useState<'confirmation' | 'recovery' | 'magic_link' | 'login_alert' | 'welcome_email'>('confirmation');

    // 2.5 New Messaging Templates Library
    const [messagingTemplates, setMessagingTemplates] = useState<any>({});
    const [selectedLibraryTemplate, setSelectedLibraryTemplate] = useState<string | null>(null);
    const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
    const [editingVariantLang, setEditingVariantLang] = useState<string>('en-US');
    const [showCreateTemplateModal, setShowCreateTemplateModal] = useState(false);
    const [newTemplateForm, setNewTemplateForm] = useState({ name: '', type: 'otp_challenge', default_language: 'en-US' });

    // 3. Policies Config
    const [emailPolicies, setEmailPolicies] = useState({
        email_confirmation: false,
        disable_magic_link: false,
        send_welcome_email: false,
        send_login_alert: false,
        login_webhook_url: ''
    });

    // PROVIDER CONFIG
    const [providerConfig, setProviderConfig] = useState<any>({ client_id: '', client_secret: '' });
    const [showProviderConfig, setShowProviderConfig] = useState<string | null>(null);

    // LINKED TABLES (Concatenation)
    const [availableTables, setAvailableTables] = useState<string[]>([]);
    const [linkedTables, setLinkedTables] = useState<string[]>([]);
    const [projectDomain, setProjectDomain] = useState<string>('');

    // CUSTOM STRATEGY STATE
    const [newStrategyName, setNewStrategyName] = useState('');
    const [showNewStrategy, setShowNewStrategy] = useState(false);

    // GENERAL
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // APP CLIENTS (Multi-App Identities)
    const [appClients, setAppClients] = useState<any[]>([]);
    const [showAppClientModal, setShowAppClientModal] = useState(false);
    const [newAppClientConfig, setNewAppClientConfig] = useState({ name: '', site_url: '', allowed_origins: '' });

    // CREATE USER STATE (Independent)
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [createUserForm, setCreateUserForm] = useState({ identifier: '', password: '', provider: 'email' });

    // UTILS
    const safeCopy = (text: string) => {
        try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            setSuccess("Copiado para área de transferência.");
            setTimeout(() => setSuccess(null), 2000);
        } catch (err) {
            setError("Erro ao copiar.");
        }
    };

    const isValidUrl = (str: string) => {
        if (str === '*' || str.startsWith('*.')) return true;
        try { new URL(str.includes('://') ? str : `https://${str}`); return true; } catch { return false; }
    };

    // --- FETCHERS ---
    const fetchData = useCallback(async () => {
        setLoadingUsers(true);
        try {
            const token = localStorage.getItem('cascata_token');
            // Fetch users with higher limit to maintain list behavior
            const [usersRes, projRes, tablesRes] = await Promise.all([
                fetch(`/api/data/${projectId}/auth/users?limit=1000`, { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch(`/api/data/${projectId}/tables`, { headers: { 'Authorization': `Bearer ${token}` } })
            ]);

            if (!usersRes.ok || !projRes.ok || !tablesRes.ok) {
                throw new Error("Falha na comunicação com o servidor.");
            }

            const usersData = await usersRes.json();
            // Handle both legacy array and new paginated object structure
            const userList = Array.isArray(usersData) ? usersData : (usersData.data || []);
            setUsers(userList);

            const projects = await projRes.json();
            const currentProj = Array.isArray(projects) ? projects.find((p: any) => p.slug === projectId) : null;

            // Store Project Info
            setProjectDomain(currentProj?.custom_domain || '');
            setSiteUrl(currentProj?.metadata?.auth_config?.site_url || '');
            setAppClients(currentProj?.metadata?.app_clients || []);

            // Load Security Config
            const sec = currentProj?.metadata?.auth_config?.security || {};
            setSecurityConfig({
                max_attempts: sec.max_attempts || 5,
                lockout_minutes: sec.lockout_minutes || 15,
                strategy: sec.strategy || 'hybrid'
            });

            // Load Email Gateway & Policies
            const authConfig = currentProj?.metadata?.auth_config || {};
            const strategyEmail = currentProj?.metadata?.auth_strategies?.email || {};

            // Merge Gateway Config
            setEmailGateway(prev => ({
                ...prev,
                ...strategyEmail,
                delivery_methods: strategyEmail.delivery_methods || []
            }));

            // Merge Policies
            setEmailPolicies({
                email_confirmation: authConfig.email_confirmation || false,
                disable_magic_link: authConfig.disable_magic_link || false,
                send_welcome_email: authConfig.send_welcome_email || false,
                send_login_alert: authConfig.send_login_alert || false,
                login_webhook_url: authConfig.login_webhook_url || ''
            });

            // Load Email Templates
            if (authConfig.email_templates) {
                setEmailTemplates((prev: any) => ({ ...prev, ...authConfig.email_templates }));
            }
            if (authConfig.messaging_templates) {
                setMessagingTemplates(authConfig.messaging_templates);
            }

            // Load Global Origins
            const rawOrigins = currentProj?.metadata?.allowed_origins || [];
            setGlobalOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? o : o.url));

            // Load Strategies
            const savedStrategies = currentProj?.metadata?.auth_strategies || {};
            const defaultStrategies = {
                email: { enabled: true, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
                google: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
                github: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 }
            };
            setStrategies({ ...defaultStrategies, ...savedStrategies });

            // Load Tables
            const tables = await tablesRes.json();
            setAvailableTables(Array.isArray(tables) ? tables.map((t: any) => t.name) : []);
            setLinkedTables(currentProj?.metadata?.linked_tables || []);

        } catch (e: any) {
            console.error("Fetch Error", e);
            setError(e.message || "Erro ao carregar dados.");
        } finally {
            setLoadingUsers(false);
        }
    }, [projectId]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // --- ACTIONS ---
    const handleVerifyPassword = async () => {
        setExecuting(true);
        try {
            const res = await fetch('/api/control/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ password: verifyPassword })
            });
            if (res.ok) {
                setIsSensitiveVisible(true);
                setShowVerifyModal(false);
                setVerifyPassword('');
            } else {
                setError("Senha incorreta.");
            }
        } catch (e) { setError("Erro na verificação."); }
        finally { setExecuting(false); }
    };

    const handleCreateUser = async () => {
        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/auth/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({
                    strategies: [{
                        provider: createUserForm.provider,
                        identifier: createUserForm.identifier,
                        password: createUserForm.password
                    }]
                })
            });
            setSuccess("Usuário criado com sucesso.");
            setShowCreateUser(false);
            setCreateUserForm({ identifier: '', password: '', provider: 'email' });
            fetchData();
        } catch (e) { setError("Erro ao criar usuário."); }
        finally { setExecuting(false); }
    };

    const saveStrategies = async (newStrategies: any, authConfig?: any, newLinkedTables?: string[], messagingTemplatesOverride?: any) => {
        setExecuting(true);
        try {
            const body: any = { authStrategies: newStrategies };
            if (authConfig) body.authConfig = authConfig;
            if (newLinkedTables) body.linked_tables = newLinkedTables;
            if (messagingTemplatesOverride) {
                if (!body.authConfig) body.authConfig = {};
                body.authConfig.messaging_templates = messagingTemplatesOverride;
            }

            // Optimistic Update
            setStrategies(newStrategies);
            if (newLinkedTables) setLinkedTables(newLinkedTables);

            // Merge Auth Config (Preserve existing providers/settings)
            const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
            const projects = await projRes.json();
            const currentProj = projects.find((p: any) => p.slug === projectId);
            const currentMetadata = currentProj?.metadata || {};

            let finalAuthConfig = currentMetadata.auth_config || {};
            if (authConfig) {
                // Merge All Top Level Keys
                finalAuthConfig = { ...finalAuthConfig, ...authConfig };
            }

            // Ensure messaging_templates is preserved if not explicitly overridden
            if (!messagingTemplatesOverride && Object.keys(messagingTemplates).length > 0) {
                finalAuthConfig.messaging_templates = messagingTemplates;
            } else if (messagingTemplatesOverride) {
                finalAuthConfig.messaging_templates = messagingTemplatesOverride;
            }

            body.authConfig = finalAuthConfig;

            await fetch(`/api/data/${projectId}/auth/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify(body)
            });

            setSuccess("Configuração salva.");
            setTimeout(() => setSuccess(null), 2000);
        } catch (e) {
            setError("Falha ao salvar.");
            fetchData();
        }
        finally { setExecuting(false); }
    };

    const handleSaveStrategyConfig = () => {
        let updatedStrategies = { ...strategies };

        if (selectedStrategy && editingStrategyName && selectedStrategy !== editingStrategyName) {
            if (updatedStrategies[editingStrategyName]) {
                setError("Este nome de estratégia já existe.");
                return;
            }
            const config = updatedStrategies[selectedStrategy];
            delete updatedStrategies[selectedStrategy];
            updatedStrategies[editingStrategyName] = { ...config, ...strategyConfig };
        } else {
            updatedStrategies[selectedStrategy!] = strategyConfig;
        }

        saveStrategies(updatedStrategies);
        setShowConfigModal(false);
    };

    const handleSaveSiteUrl = () => {
        saveStrategies(strategies, { site_url: siteUrl });
    };

    // --- APP CLIENTS LOGIC ---
    const updateAppClientsMeta = async (newClients: any[]) => {
        setExecuting(true);
        try {
            const res = await fetch(`/api/control/projects/${projectId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ metadata: { app_clients: newClients } })
            });
            if (res.ok) {
                setAppClients(newClients);
                setSuccess("App Clients atualizados com sucesso.");
                setTimeout(() => setSuccess(null), 2000);
            } else {
                throw new Error("Falha ao salvar metadados.");
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setExecuting(false);
        }
    };

    const handleSaveAppClient = async () => {
        if (!newAppClientConfig.name) return;
        const newClient = {
            id: 'client_' + Math.random().toString(36).substr(2, 9),
            name: newAppClientConfig.name,
            anon_key: crypto.randomUUID(),
            site_url: newAppClientConfig.site_url,
            allowed_origins: newAppClientConfig.allowed_origins.split(',').map(s => s.trim()).filter(Boolean)
        };
        const updated = [...appClients, newClient];
        await updateAppClientsMeta(updated);
        setShowAppClientModal(false);
        setNewAppClientConfig({ name: '', site_url: '', allowed_origins: '' });
    };

    const handleDeleteAppClient = async (clientId: string) => {
        if (!confirm("This will instantly revoke access for this anon_key. Are you sure?")) return;
        const updated = appClients.filter(c => c.id !== clientId);
        await updateAppClientsMeta(updated);
    };

    const handleSaveSecurity = () => {
        saveStrategies(strategies, { security: securityConfig });
    };

    const handleSaveEmailCenter = () => {
        // 1. Update Strategy 'email' with Gateway Config
        const updatedStrategies = {
            ...strategies,
            email: {
                ...strategies.email,
                ...emailGateway
            }
        };

        // 2. Update Auth Config with Policies & Templates
        const updatedAuthConfig = {
            email_templates: emailTemplates,
            ...emailPolicies
        };

        saveStrategies(updatedStrategies, updatedAuthConfig);
    };

    const openProviderConfig = async (provider: string) => {
        setShowProviderConfig(provider);
        try {
            const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
            const projects = await projRes.json();
            const currentProj = projects.find((p: any) => p.slug === projectId);
            const conf = currentProj?.metadata?.auth_config?.providers?.[provider] || { client_id: '', client_secret: '', authorized_clients: '', skip_nonce: false };
            setProviderConfig(conf);
        } catch (e) { }
    };

    const handleSaveProviderConfig = () => {
        if (!showProviderConfig) return;
        // We pass just the specific provider update, assuming saveStrategies merges correctly
        saveStrategies(strategies, { providers: { [showProviderConfig]: providerConfig } });
        setShowProviderConfig(null);
    };

    const addRuleToStrategy = (origin: string, requireCode: boolean) => {
        if (!isValidUrl(origin)) { alert("URL inválida."); return; }
        setStrategyConfig(prev => {
            if (!prev) return prev;
            const currentRules = prev.rules || [];
            if (currentRules.some((r: any) => r.origin === origin)) {
                return { ...prev, newRule: '' };
            }
            return {
                ...prev,
                rules: [...currentRules, { origin, require_code: requireCode }],
                newRule: ''
            };
        });
    };

    const removeRuleFromStrategy = (origin: string) => {
        setStrategyConfig({
            ...strategyConfig,
            rules: (strategyConfig.rules || []).filter((r: any) => r.origin !== origin)
        });
    };

    const toggleLinkedTable = (tableName: string) => {
        const next = linkedTables.includes(tableName)
            ? linkedTables.filter(t => t !== tableName)
            : [...linkedTables, tableName];
        saveStrategies(strategies, null, next);
    };

    const handleBlockUser = async (user: any) => {
        try {
            await fetch(`/api/data/${projectId}/auth/users/${user.id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ banned: !user.banned })
            });
            if (selectedUser && selectedUser.id === user.id) {
                setSelectedUser({ ...selectedUser, banned: !user.banned });
            }
            fetchData();
            setSuccess(user.banned ? "Usuário desbloqueado." : "Usuário bloqueado.");
        } catch (e) { setError("Erro ao alterar status."); }
    };

    const handleDeleteUser = async () => {
        if (deleteConfirmUuid !== showDeleteModal?.id) { setError("UUID incorreto."); return; }
        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/auth/users/${showDeleteModal.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
            });
            setShowDeleteModal(null);
            setShowUserModal(false);
            setDeleteConfirmUuid('');
            fetchData();
            setSuccess("Usuário excluído permanentemente.");
        } catch (e) { setError("Erro ao excluir."); }
        finally { setExecuting(false); }
    };

    const handleLinkIdentity = async () => {
        if (!selectedUser) return;
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/identities`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
                },
                body: JSON.stringify(linkIdentityForm)
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Failed to link identity");
            }

            setSuccess("Nova identidade vinculada.");
            setShowLinkIdentity(false);
            setLinkIdentityForm({ provider: 'email', identifier: '', password: '' });

            // Refresh user data
            fetchData();
            setShowUserModal(false);

        } catch (e: any) {
            setError(e.message);
        } finally {
            setExecuting(false);
        }
    };

    const fetchActiveSessions = async (userId: string) => {
        setLoadingSessions(true);
        try {
            const res = await fetch(`/api/data/${projectId}/auth/users/${userId}/sessions`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
            });
            if (res.ok) {
                const data = await res.json();
                setActiveSessions(data);
            }
        } catch (e) {
            console.error("Failed to fetch sessions");
        } finally {
            setLoadingSessions(false);
        }
    };

    const handleRevokeSession = async (sessionId: string) => {
        if (!confirm("Revogar esta sessão? O dispositivo será deslogado imediatamente.")) return;
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
            });
            if (res.ok) {
                setSuccess("Sessão revogada com sucesso.");
                fetchActiveSessions(selectedUser.id);
            } else {
                setError("Erro ao revogar sessão.");
            }
        } catch (e) {
            setError("Erro na conexão.");
        } finally {
            setExecuting(false);
        }
    };

    const handleRevokeOtherSessions = async () => {
        if (!confirm("Desconectar TODOS os outros dispositivos deste usuário?")) return;
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/sessions`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
                },
                body: JSON.stringify({ current_session_id: null }) // We are admin, we revoke all
            });
            if (res.ok) {
                setSuccess("Demais sessões revogadas com sucesso.");
                fetchActiveSessions(selectedUser.id);
            } else {
                setError("Erro ao revogar sessões.");
            }
        } catch (e) {
            setError("Erro na conexão.");
        } finally {
            setExecuting(false);
        }
    };

    const handleUnlinkIdentity = async (identityId: string) => {
        if (!confirm("Remover esta forma de acesso do usuário?")) return;
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/strategies/${identityId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
            });
            if (!res.ok) throw new Error((await res.json()).error);

            setSuccess("Identidade removida.");
            fetchData();
            setShowUserModal(false);
        } catch (e: any) { setError(e.message); }
        finally { setExecuting(false); }
    };

    const toggleStrategy = async (key: string) => {
        const currentEnabled = strategies[key]?.enabled;
        const updatedStrategies = {
            ...strategies,
            [key]: { ...strategies[key], enabled: !currentEnabled }
        };
        await saveStrategies(updatedStrategies);
    };

    const handleCreateCustomStrategy = () => {
        if (!newStrategyName) return;
        const key = newStrategyName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (strategies[key]) { setError("Strategy já existe."); return; }

        const newStrategies = {
            ...strategies,
            [key]: {
                enabled: true,
                rules: [],
                jwt_expiration: '24h',
                refresh_validity_days: 30,
                otp_config: { length: 6, charset: 'numeric' }
            }
        };
        saveStrategies(newStrategies);
        setNewStrategyName('');
        setShowNewStrategy(false);
    };

    const handleDeleteStrategy = (key: string) => {
        if (!confirm(`Excluir permanentemente a strategy "${key}"? Usuários que usam apenas este método perderão acesso.`)) return;
        const { [key]: deleted, ...rest } = strategies;
        saveStrategies(rest);
    };

    // --- TEMPLATE LIBRARY HANDLERS ---
    const handleCreateTemplate = () => {
        if (!newTemplateForm.name) return;
        const id = 'tpl_' + Math.random().toString(36).substr(2, 9);
        const newTpl = {
            id,
            name: newTemplateForm.name,
            type: newTemplateForm.type,
            default_language: newTemplateForm.default_language,
            variants: {
                [newTemplateForm.default_language]: { subject: '', body: '' }
            }
        };
        const updated = { ...messagingTemplates, [id]: newTpl };
        setMessagingTemplates(updated);
        setEditingTemplate(id);
        setEditingVariantLang(newTemplateForm.default_language);
        setShowCreateTemplateModal(false);
        setNewTemplateForm({ name: '', type: 'otp_challenge', default_language: 'en-US' });
    };

    const handleDeleteTemplate = (tplId: string) => {
        if (!confirm('Permanently delete this template and all its language variants?')) return;
        const { [tplId]: _, ...rest } = messagingTemplates;
        setMessagingTemplates(rest);
        if (editingTemplate === tplId) setEditingTemplate(null);
    };

    const handleUpdateVariant = (tplId: string, lang: string, field: 'subject' | 'body', value: string) => {
        setMessagingTemplates((prev: any) => ({
            ...prev,
            [tplId]: {
                ...prev[tplId],
                variants: {
                    ...prev[tplId].variants,
                    [lang]: { ...prev[tplId].variants[lang], [field]: value }
                }
            }
        }));
    };

    const handleAddVariant = (tplId: string, lang: string) => {
        if (!lang || messagingTemplates[tplId]?.variants?.[lang]) return;
        setMessagingTemplates((prev: any) => ({
            ...prev,
            [tplId]: {
                ...prev[tplId],
                variants: { ...prev[tplId].variants, [lang]: { subject: '', body: '' } }
            }
        }));
        setEditingVariantLang(lang);
    };

    const handleRemoveVariant = (tplId: string, lang: string) => {
        const tpl = messagingTemplates[tplId];
        if (!tpl || Object.keys(tpl.variants).length <= 1) {
            setError('A template must have at least one language variant.');
            return;
        }
        if (tpl.default_language === lang) {
            setError('Cannot remove the default language. Change the default first.');
            return;
        }
        const { [lang]: _, ...restVariants } = tpl.variants;
        setMessagingTemplates((prev: any) => ({
            ...prev,
            [tplId]: { ...prev[tplId], variants: restVariants }
        }));
        setEditingVariantLang(Object.keys(restVariants)[0]);
    };

    const handleSaveTemplateLibrary = () => {
        saveStrategies(strategies, undefined, undefined, messagingTemplates);
    };

    const filteredUsers = useMemo(() => {
        if (!Array.isArray(users)) return [];

        let list = users.filter(u =>
            u.id.includes(searchQuery) ||
            u.identities?.some((i: any) => i.identifier.toLowerCase().includes(searchQuery.toLowerCase()))
        );
        if (sortBy === 'alpha') {
            list.sort((a, b) => (a.identities?.[0]?.identifier || '').localeCompare(b.identities?.[0]?.identifier || ''));
        } else {
            list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        }
        return list;
    }, [users, searchQuery, sortBy]);

    const paginatedUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));

    const isOauth = (s: string) => ['google', 'github', 'facebook', 'twitter'].includes(s);

    const isAggressiveSecurity = securityConfig.max_attempts < 3 || securityConfig.lockout_minutes > 60;

    // --- CALLBACK URL HELPER ---
    const getCallbackUrl = () => {
        const host = projectDomain || window.location.host;
        const protocol = projectDomain ? 'https' : window.location.protocol.replace(':', '');
        const prefix = projectDomain ? '' : `/api/data/${projectId}`;
        return `${protocol}://${host}${prefix}/auth/v1/callback`;
    };

    return (
        <div className="flex h-full bg-[#F8FAFC]">
            {(error || success) && (
                <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
                    {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                    <span className="text-xs font-bold">{error || success}</span>
                    <button onClick={() => { setError(null); setSuccess(null); }}><X size={14} className="opacity-60 hover:opacity-100" /></button>
                </div>
            )}

            {/* SIDEBAR NAVIGATION */}
            <nav className="w-[260px] bg-white border-r border-slate-200 shrink-0 flex flex-col">
                <div className="p-6 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                        <div className="w-11 h-11 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-lg">
                            <Fingerprint size={22} />
                        </div>
                        <div>
                            <h2 className="text-lg font-black text-slate-900 tracking-tight leading-none">Auth</h2>
                            <p className="text-[9px] text-indigo-600 font-bold uppercase tracking-[0.15em] mt-0.5">Identity & Access</p>
                        </div>
                    </div>
                </div>
                <div className="flex-1 p-3 space-y-1 overflow-y-auto">
                    {[
                        { id: 'users' as const, icon: Users, label: 'Users', desc: 'Directory & Sessions', count: users.length },
                        { id: 'strategies' as const, icon: Key, label: 'Strategies', desc: 'Identity Providers', count: Object.keys(strategies).length },
                        { id: 'messaging' as const, icon: Send, label: 'Messaging', desc: 'Templates & Gateway' },
                        { id: 'security' as const, icon: ShieldAlert, label: 'Security', desc: 'Lockout & Policies' },
                        { id: 'apps' as const, icon: Plug, label: 'App Clients', desc: 'Keys & Origins', count: appClients.length },
                        { id: 'schema' as const, icon: Layers, label: 'Schema', desc: 'Table Linking' },
                    ].map(item => (
                        <button
                            key={item.id}
                            onClick={() => setActiveSection(item.id)}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all text-left group ${activeSection === item.id
                                ? 'bg-indigo-50 text-indigo-700'
                                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                                }`}
                        >
                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${activeSection === item.id ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200'
                                }`}>
                                <item.icon size={18} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between">
                                    <span className={`text-xs font-black uppercase tracking-widest ${activeSection === item.id ? 'text-indigo-700' : ''}`}>{item.label}</span>
                                    {item.count !== undefined && item.count > 0 && (
                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${activeSection === item.id ? 'bg-indigo-200 text-indigo-700' : 'bg-slate-100 text-slate-400'}`}>{item.count}</span>
                                    )}
                                </div>
                                <p className="text-[9px] font-medium text-slate-400 truncate mt-0.5">{item.desc}</p>
                            </div>
                        </button>
                    ))}
                </div>
                <div className="p-4 border-t border-slate-100">
                    <div className="text-[8px] font-bold text-slate-300 uppercase tracking-widest text-center">Cascata Auth Engine</div>
                </div>
            </nav>

            {/* MAIN CONTENT */}
            <div className="flex-1 overflow-y-auto">
                {/* USERS SECTION */}
                {activeSection === 'users' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">User Directory</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Manage identities, sessions, and access across all strategies.</p>
                        </div>
                        <div className="flex justify-between items-center bg-white p-4 rounded-[2rem] shadow-sm border border-slate-100">
                            <div className="flex items-center gap-4">
                                <div className="relative group">
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                    <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search UUID, email..." className="pl-12 pr-6 py-3 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none w-64 focus:ring-2 focus:ring-indigo-500/20 transition-all" />
                                </div>
                                <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-xl">
                                    <Filter size={14} className="text-slate-400" />
                                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="bg-transparent text-xs font-bold text-slate-600 outline-none">
                                        <option value="date">Newest First</option>
                                        <option value="alpha">A-Z</option>
                                    </select>
                                </div>
                            </div>

                            <div className="flex items-center gap-4">
                                <button onClick={() => setShowCreateUser(true)} className="bg-indigo-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100">
                                    <UserPlus size={16} /> New User
                                </button>
                                <button onClick={() => isSensitiveVisible ? setIsSensitiveVisible(false) : setShowVerifyModal(true)} className={`flex items-center gap-2 px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${isSensitiveVisible ? 'bg-amber-50 text-amber-600' : 'bg-slate-900 text-white'}`}>
                                    {isSensitiveVisible ? <><EyeOff size={14} /> Hide Data</> : <><Eye size={14} /> Reveal Data</>}
                                </button>
                            </div>
                        </div>

                        {loadingUsers ? (
                            <div className="py-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>
                        ) : (
                            <div className="space-y-4">
                                {paginatedUsers.length === 0 && <p className="text-center py-10 text-slate-400 font-bold text-xs uppercase">No users found</p>}
                                {paginatedUsers.map(u => (
                                    <div
                                        key={u.id}
                                        onClick={() => {
                                            setSelectedUser(u);
                                            setShowUserModal(true);
                                            fetchActiveSessions(u.id);
                                        }}
                                        className={`bg-white border ${u.banned ? 'border-rose-200 bg-rose-50/10' : 'border-slate-200'} rounded-[2.5rem] p-6 hover:shadow-xl transition-all group relative overflow-hidden cursor-pointer`}
                                    >
                                        {u.banned && <div className="absolute top-0 right-0 bg-rose-500 text-white text-[9px] font-black px-4 py-1 rounded-bl-xl uppercase tracking-widest">Banned</div>}
                                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                                            <div className="flex items-center gap-6">
                                                <div className={`w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center text-white text-xl font-bold shadow-lg ${u.banned ? 'bg-rose-400' : 'bg-slate-900'}`}>
                                                    {(u.raw_user_meta_data?.avatar_url || u.raw_user_meta_data?.picture) ? (
                                                        <img src={u.raw_user_meta_data?.avatar_url || u.raw_user_meta_data?.picture} alt="Avatar" className="w-full h-full object-cover" />
                                                    ) : (
                                                        u.identities?.[0]?.identifier?.[0]?.toUpperCase() || <Users />
                                                    )}
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">UUID</span>
                                                        <code className="text-[10px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{u.id}</code>
                                                        <button onClick={(e) => { e.stopPropagation(); safeCopy(u.id); }} className="text-slate-300 hover:text-indigo-600"><Copy size={12} /></button>
                                                    </div>
                                                    <h4 className={`text-lg font-bold ${isSensitiveVisible ? 'text-slate-900' : 'text-slate-400 blur-[4px] select-none'} transition-all`}>
                                                        {u.identities?.[0]?.identifier || 'Unknown Identity'}
                                                    </h4>
                                                    <div className="flex gap-4 mt-1">
                                                        <p className="text-[10px] text-slate-400 font-bold">Created: {new Date(u.created_at).toLocaleDateString()}</p>
                                                        {u.identities?.some((i: any) => i.verified_at) ? (
                                                            <p className="text-[10px] text-emerald-500 font-bold flex items-center gap-1"><CheckCircle2 size={10} /> Verified</p>
                                                        ) : (
                                                            <p className="text-[10px] text-amber-500 font-bold flex items-center gap-1"><AlertCircle size={10} /> Unverified</p>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-3">
                                                {u.identities?.map((id: any, idx: number) => (
                                                    <div key={idx} className="bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-lg flex items-center gap-2">
                                                        <span className="text-[9px] font-black uppercase text-indigo-600">{id.provider}</span>
                                                        {id.verified_at ? (
                                                            <CheckCircle2 size={10} className="text-emerald-500" />
                                                        ) : (
                                                            <AlertCircle size={10} className="text-amber-400" />
                                                        )}
                                                    </div>
                                                ))}
                                                <div className="px-4 text-slate-300"><ChevronRight size={16} /></div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex justify-center items-center gap-6 pt-4">
                            <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="p-3 rounded-xl bg-white border border-slate-200 disabled:opacity-50 hover:bg-slate-50"><ChevronLeft size={16} /></button>
                            <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Page {page} of {totalPages}</span>
                            <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)} className="p-3 rounded-xl bg-white border border-slate-200 disabled:opacity-50 hover:bg-slate-50"><ChevronRight size={16} /></button>
                        </div>
                    </div>
                )}

                {/* APP CLIENTS SECTION */}
                {activeSection === 'apps' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">App Clients</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Identity-aware API keys and allowed origins per application.</p>
                        </div>
                        <div className="space-y-8">

                            {/* IDENTITY-AWARE APP CLIENTS */}
                            <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
                                    <div className="flex items-center gap-4">
                                        <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><Layers size={20} /></div>
                                        <div>
                                            <h3 className="text-2xl font-black text-slate-900 tracking-tight">App Clients</h3>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Identity-Aware Keys & Origins</p>
                                        </div>
                                    </div>
                                    <button onClick={() => setShowAppClientModal(true)} className="bg-slate-900 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-slate-800 transition-all shrink-0">
                                        <Plus size={16} /> New App Client
                                    </button>
                                </div>

                                <div className="space-y-6">
                                    {/* BASE CLIENT */}
                                    <div className="p-6 rounded-[2rem] border border-slate-200 bg-slate-50 flex flex-col gap-4">
                                        <div className="flex justify-between items-center">
                                            <div>
                                                <h4 className="font-bold text-indigo-900 flex items-center gap-2"><Lock size={14} /> Default Client (Base Key)</h4>
                                                <p className="text-[10px] text-slate-500 mt-1">Primary fallback anon_key for older apps and API Docs.</p>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Global Site URL</label>
                                            <div className="flex gap-2">
                                                <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://app.cascata.io" className="flex-1 bg-white border border-slate-200 rounded-xl py-2 px-4 text-xs font-bold font-mono outline-none" />
                                                <button onClick={handleSaveSiteUrl} disabled={executing} className="bg-indigo-600 text-white px-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-indigo-700 transition-all">Save</button>
                                            </div>
                                        </div>
                                    </div>

                                    {/* SPECIFIC CLIENTS */}
                                    {appClients.map(client => (
                                        <div key={client.id} className="p-6 rounded-[2rem] border border-slate-200 bg-white shadow-sm flex flex-col gap-4 relative group">
                                            <button onClick={() => handleDeleteAppClient(client.id)} className="absolute top-6 right-6 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100 bg-white p-2 rounded-lg shadow-sm">
                                                <Trash2 size={16} />
                                            </button>
                                            <div className="pr-10">
                                                <h4 className="font-bold text-slate-900">{client.name}</h4>
                                                <div className="flex items-center gap-2 mt-2">
                                                    <code className="text-[10px] bg-slate-100 text-slate-600 px-2 py-1 rounded truncate flex-1">{client.anon_key}</code>
                                                    <button onClick={() => safeCopy(client.anon_key)} className="text-slate-400 hover:text-indigo-600"><Copy size={14} /></button>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2 pt-4 border-t border-slate-100">
                                                <div>
                                                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Site URL (Fallback)</label>
                                                    <p className="text-[11px] font-mono font-bold text-slate-700 mt-1 truncate w-full">{client.site_url}</p>
                                                </div>
                                                <div>
                                                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Allowed Origins (CORS)</label>
                                                    <p className="text-[10px] font-medium text-slate-500 mt-1">{client.allowed_origins?.join(', ') || 'Global Wide Open'}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* GLOBAL IDENTITY POLICIES (REDESIGNED) */}
                        </div>
                    </div>
                )}

                {/* MESSAGING SECTION */}
                {activeSection === 'messaging' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">Messaging & Templates</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Configure delivery gateway, email templates, i18n template library, and identity policies.</p>
                        </div>
                        <div className="space-y-8">
                            <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                                <div className="flex items-center justify-between mb-8">
                                    <div className="flex items-center gap-4">
                                        <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><MessageSquare size={20} /></div>
                                        <div>
                                            <h3 className="text-2xl font-black text-slate-900 tracking-tight">Messaging & Policies</h3>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Global Identity Flows & Templates</p>
                                        </div>
                                    </div>
                                </div>

                                {/* TABS */}
                                <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl mb-8 w-fit">
                                    {['gateway', 'templates', 'library', 'policies'].map((t) => (
                                        <button
                                            key={t}
                                            onClick={() => setEmailTab(t as any)}
                                            className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${emailTab === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>

                                {/* TAB 1: GATEWAY (PROVIDER CONFIG) */}
                                {emailTab === 'gateway' && (
                                    <div className="space-y-8 animate-in fade-in slide-in-from-right-2">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                            <div className="space-y-4">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Delivery Channels (Multi-Select)</label>
                                                <div className="grid grid-cols-3 gap-3">
                                                    <button
                                                        onClick={() => setEmailGateway({
                                                            ...emailGateway,
                                                            delivery_methods: (emailGateway.delivery_methods || []).includes('smtp')
                                                                ? (emailGateway.delivery_methods || []).filter((m: string) => m !== 'smtp')
                                                                : [...(emailGateway.delivery_methods || []), 'smtp']
                                                        })}
                                                        className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${(emailGateway.delivery_methods || []).includes('smtp') ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-inner' : 'border-slate-200 text-slate-400'}`}>
                                                        <Server size={18} /> SMTP
                                                    </button>
                                                    <button
                                                        onClick={() => setEmailGateway({
                                                            ...emailGateway,
                                                            delivery_methods: (emailGateway.delivery_methods || []).includes('resend')
                                                                ? (emailGateway.delivery_methods || []).filter((m: string) => m !== 'resend')
                                                                : [...(emailGateway.delivery_methods || []), 'resend']
                                                        })}
                                                        className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${(emailGateway.delivery_methods || []).includes('resend') ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-inner' : 'border-slate-200 text-slate-400'}`}>
                                                        <Send size={18} /> Resend
                                                    </button>
                                                    <button
                                                        onClick={() => setEmailGateway({
                                                            ...emailGateway,
                                                            delivery_methods: (emailGateway.delivery_methods || []).includes('webhook')
                                                                ? (emailGateway.delivery_methods || []).filter((m: string) => m !== 'webhook')
                                                                : [...(emailGateway.delivery_methods || []), 'webhook']
                                                        })}
                                                        className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${(emailGateway.delivery_methods || []).includes('webhook') ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-inner' : 'border-slate-200 text-slate-400'}`}>
                                                        <Plug size={18} /> Webhook
                                                    </button>
                                                </div>
                                            </div>

                                            {(!(emailGateway.delivery_methods || []).includes('webhook') || (emailGateway.delivery_methods || []).length > 1) && (
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Sender Email (From)</label>
                                                    <input
                                                        value={emailGateway.from_email || ''}
                                                        onChange={(e) => setEmailGateway({ ...emailGateway, from_email: e.target.value })}
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                        placeholder="noreply@myapp.com"
                                                    />
                                                </div>
                                            )}
                                        </div>

                                        {(emailGateway.delivery_methods || []).includes('resend') && (
                                            <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Resend API Key</label>
                                                <input
                                                    type="password"
                                                    value={emailGateway.resend_api_key || ''}
                                                    onChange={(e) => setEmailGateway({ ...emailGateway, resend_api_key: e.target.value })}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                                    placeholder="re_123..."
                                                />
                                            </div>
                                        )}

                                        {(emailGateway.delivery_methods || []).includes('smtp') && (
                                            <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-1">
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">SMTP Host</label>
                                                    <input
                                                        value={emailGateway.smtp_host || ''}
                                                        onChange={(e) => setEmailGateway({ ...emailGateway, smtp_host: e.target.value })}
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                        placeholder="smtp.gmail.com"
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Port</label>
                                                    <input
                                                        value={emailGateway.smtp_port || 587}
                                                        onChange={(e) => setEmailGateway({ ...emailGateway, smtp_port: parseInt(e.target.value) })}
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                        type="number"
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">User</label>
                                                    <input
                                                        value={emailGateway.smtp_user || ''}
                                                        onChange={(e) => setEmailGateway({ ...emailGateway, smtp_user: e.target.value })}
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
                                                    <input
                                                        type="password"
                                                        value={emailGateway.smtp_pass || ''}
                                                        onChange={(e) => setEmailGateway({ ...emailGateway, smtp_pass: e.target.value })}
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        {(emailGateway.delivery_methods || []).includes('webhook') && (
                                            <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Webhook URL</label>
                                                <input
                                                    value={emailGateway.webhook_url || ''}
                                                    onChange={(e) => setEmailGateway({ ...emailGateway, webhook_url: e.target.value })}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                    placeholder="https://n8n.webhook/..."
                                                />
                                            </div>
                                        )}

                                        <div className="pt-4 border-t border-slate-100">
                                            <button onClick={handleSaveEmailCenter} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                                {executing ? <Loader2 className="animate-spin" size={14} /> : 'Save Connection Settings'}
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* TAB 2: TEMPLATES */}
                                {emailTab === 'templates' && (
                                    <div className="space-y-6 animate-in fade-in slide-in-from-right-2">
                                        <div className="flex gap-2 p-1 bg-slate-50 rounded-xl border border-slate-100 overflow-x-auto">
                                            {['confirmation', 'recovery', 'magic_link', 'login_alert', 'welcome_email'].map((t) => (
                                                <button
                                                    key={t}
                                                    onClick={() => setActiveTemplateTab(t as any)}
                                                    className={`flex-1 py-2 px-4 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all whitespace-nowrap ${activeTemplateTab === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                                                >
                                                    {t.replace('_', ' ')}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="space-y-4">
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Subject</label>
                                                <input
                                                    value={emailTemplates[activeTemplateTab]?.subject || ''}
                                                    onChange={(e) => setEmailTemplates({ ...emailTemplates, [activeTemplateTab]: { ...emailTemplates[activeTemplateTab], subject: e.target.value } })}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-bold text-slate-900 outline-none"
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">HTML Body</label>
                                                <textarea
                                                    value={emailTemplates[activeTemplateTab]?.body || ''}
                                                    onChange={(e) => setEmailTemplates({ ...emailTemplates, [activeTemplateTab]: { ...emailTemplates[activeTemplateTab], body: e.target.value } })}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-medium text-slate-900 outline-none min-h-[250px] font-mono"
                                                />
                                                <p className="text-[10px] text-slate-400 px-2">Variables: <code>{"{{ .ConfirmationURL }}"}</code>, <code>{"{{ .Token }}"}</code>, <code>{"{{ .Email }}"}</code>, <code>{"{{ .Date }}"}</code></p>
                                            </div>
                                        </div>

                                        <button onClick={handleSaveEmailCenter} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                            {executing ? <Loader2 className="animate-spin" size={14} /> : 'Save Templates'}
                                        </button>
                                    </div>
                                )}

                                {/* TAB: TEMPLATE LIBRARY (i18n) */}
                                {emailTab === 'library' && (
                                    <div className="space-y-6 animate-in fade-in slide-in-from-right-2">
                                        <div className="flex justify-between items-center">
                                            <div>
                                                <h4 className="text-sm font-black text-slate-900">Message Template Library</h4>
                                                <p className="text-[10px] text-slate-400 font-bold mt-1">Reusable i18n templates for OTPs, Confirmations, Alerts, and more — across all strategies.</p>
                                            </div>
                                            <button onClick={() => setShowCreateTemplateModal(true)} className="bg-indigo-600 text-white px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 transition-all shadow-lg">
                                                <Plus size={14} /> New Template
                                            </button>
                                        </div>

                                        {Object.keys(messagingTemplates).length === 0 && (
                                            <div className="py-16 text-center border-2 border-dashed border-slate-200 rounded-3xl">
                                                <LayoutTemplate size={40} className="mx-auto text-slate-300 mb-4" />
                                                <p className="text-sm font-bold text-slate-400">No templates yet</p>
                                                <p className="text-[10px] text-slate-400 mt-1">Create your first messaging template to enable i18n across all strategies.</p>
                                            </div>
                                        )}

                                        {/* Template Gallery Cards */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {Object.values(messagingTemplates).map((tpl: any) => (
                                                <div
                                                    key={tpl.id}
                                                    onClick={() => { setEditingTemplate(tpl.id); setEditingVariantLang(tpl.default_language); }}
                                                    className={`relative p-6 rounded-[2rem] border cursor-pointer transition-all group ${editingTemplate === tpl.id ? 'bg-indigo-50 border-indigo-300 shadow-lg' : 'bg-white border-slate-200 hover:shadow-md hover:border-slate-300'}`}
                                                >
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tpl.id); }}
                                                        className="absolute top-4 right-4 p-1.5 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"
                                                    ><Trash2 size={14} /></button>
                                                    <div className="flex items-start gap-3 mb-3">
                                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${editingTemplate === tpl.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                                            <LayoutTemplate size={18} />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <h5 className="font-bold text-slate-900 text-sm truncate">{tpl.name}</h5>
                                                            <p className="text-[9px] font-black text-indigo-600 uppercase tracking-widest mt-0.5">{tpl.type.replace(/_/g, ' ')}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-[9px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-lg">Default: {tpl.default_language}</span>
                                                        <span className="text-[9px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-lg">{Object.keys(tpl.variants || {}).length} variant{Object.keys(tpl.variants || {}).length !== 1 ? 's' : ''}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* INLINE VARIANT EDITOR */}
                                        {editingTemplate && messagingTemplates[editingTemplate] && (() => {
                                            const tpl = messagingTemplates[editingTemplate];
                                            const variantKeys = Object.keys(tpl.variants || {});
                                            const currentVariant = tpl.variants?.[editingVariantLang] || { subject: '', body: '' };

                                            return (
                                                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm space-y-6">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <h4 className="text-lg font-black text-slate-900 flex items-center gap-2">
                                                                <Edit2 size={16} className="text-indigo-600" /> {tpl.name}
                                                            </h4>
                                                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{tpl.type.replace(/_/g, ' ')} • Default: {tpl.default_language}</p>
                                                        </div>
                                                        <button onClick={() => setEditingTemplate(null)} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-xl"><X size={18} /></button>
                                                    </div>

                                                    {/* Language Variant Tabs */}
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        {variantKeys.map(lang => (
                                                            <button
                                                                key={lang}
                                                                onClick={() => setEditingVariantLang(lang)}
                                                                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${editingVariantLang === lang ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                                            >
                                                                <Globe size={12} /> {lang}
                                                                {lang === tpl.default_language && <span className="text-[8px] opacity-70">(default)</span>}
                                                            </button>
                                                        ))}
                                                        <div className="flex items-center gap-1 ml-2">
                                                            <input
                                                                placeholder="es-ES"
                                                                className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-[10px] font-bold outline-none"
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') {
                                                                        handleAddVariant(editingTemplate!, (e.target as HTMLInputElement).value.trim());
                                                                        (e.target as HTMLInputElement).value = '';
                                                                    }
                                                                }}
                                                            />
                                                            <span className="text-[9px] text-slate-400 font-bold">Enter to add</span>
                                                        </div>
                                                    </div>

                                                    {/* Subject + Body Editor */}
                                                    <div className="space-y-4">
                                                        <div className="space-y-2">
                                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Subject ({editingVariantLang})</label>
                                                            <input
                                                                value={currentVariant.subject}
                                                                onChange={(e) => handleUpdateVariant(editingTemplate!, editingVariantLang, 'subject', e.target.value)}
                                                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-bold text-slate-900 outline-none"
                                                                placeholder="e.g. Your Verification Code"
                                                            />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Body ({editingVariantLang})</label>
                                                            <textarea
                                                                value={currentVariant.body}
                                                                onChange={(e) => handleUpdateVariant(editingTemplate!, editingVariantLang, 'body', e.target.value)}
                                                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-medium text-slate-900 outline-none min-h-[180px] font-mono"
                                                                placeholder="HTML or plain text body..."
                                                            />
                                                            <p className="text-[10px] text-slate-400 px-2">Variables: <code>{"{{ .Code }}"}</code>, <code>{"{{ .ConfirmationURL }}"}</code>, <code>{"{{ .Email }}"}</code>, <code>{"{{ .AppName }}"}</code>, <code>{"{{ .Expiration }}"}</code>, <code>{"{{ .Date }}"}</code>, <code>{"{{ .Identifier }}"}</code>, <code>{"{{ .Strategy }}"}</code></p>
                                                        </div>
                                                    </div>

                                                    {/* Remove Variant */}
                                                    {variantKeys.length > 1 && editingVariantLang !== tpl.default_language && (
                                                        <button
                                                            onClick={() => handleRemoveVariant(editingTemplate!, editingVariantLang)}
                                                            className="text-[10px] font-bold text-rose-500 hover:text-rose-700 flex items-center gap-1"
                                                        >
                                                            <Trash2 size={12} /> Remove &quot;{editingVariantLang}&quot; variant
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })()}

                                        <button onClick={handleSaveTemplateLibrary} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                            {executing ? <Loader2 className="animate-spin" size={14} /> : 'Save Template Library'}
                                        </button>
                                    </div>
                                )}

                                {/* TAB 3: POLICIES (FLOWS) */}
                                {emailTab === 'policies' && (
                                    <div className="space-y-8 animate-in fade-in slide-in-from-right-2">
                                        <div className="grid grid-cols-1 gap-4">
                                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.email_confirmation ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({ ...p, email_confirmation: !p.email_confirmation }))}>
                                                <div className="flex justify-between items-center">
                                                    <div>
                                                        <h4 className={`font-bold text-sm ${emailPolicies.email_confirmation ? 'text-indigo-900' : 'text-slate-500'}`}>Require Identity Confirmation</h4>
                                                        <p className="text-[10px] text-slate-400 mt-1">Users cannot login until they verify their primary identifier (Email, Phone, etc).</p>
                                                    </div>
                                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.email_confirmation ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.email_confirmation ? 'translate-x-5' : ''}`}></div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.disable_magic_link ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({ ...p, disable_magic_link: !p.disable_magic_link }))}>
                                                <div className="flex justify-between items-center">
                                                    <div>
                                                        <h4 className={`font-bold text-sm ${emailPolicies.disable_magic_link ? 'text-rose-900' : 'text-slate-500'}`}>Disable Magic Links / Passwordless</h4>
                                                        <p className="text-[10px] text-slate-400 mt-1">Prevent users from logging in via OTP or link without a password.</p>
                                                    </div>
                                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.disable_magic_link ? 'bg-rose-600' : 'bg-slate-300'}`}>
                                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.disable_magic_link ? 'translate-x-5' : ''}`}></div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.send_welcome_email ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({ ...p, send_welcome_email: !p.send_welcome_email }))}>
                                                <div className="flex justify-between items-center">
                                                    <div>
                                                        <h4 className={`font-bold text-sm ${emailPolicies.send_welcome_email ? 'text-emerald-900' : 'text-slate-500'}`}><PartyPopper className="inline mr-2" size={14} /> Send Welcome Message</h4>
                                                        <p className="text-[10px] text-slate-400 mt-1">Automatically trigger a welcome notification upon signup (or verification).</p>
                                                    </div>
                                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.send_welcome_email ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.send_welcome_email ? 'translate-x-5' : ''}`}></div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.send_login_alert ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({ ...p, send_login_alert: !p.send_login_alert }))}>
                                                <div className="flex justify-between items-center">
                                                    <div>
                                                        <h4 className={`font-bold text-sm ${emailPolicies.send_login_alert ? 'text-amber-900' : 'text-slate-500'}`}><BellRing className="inline mr-2" size={14} /> Login Notification Alert</h4>
                                                        <p className="text-[10px] text-slate-400 mt-1">Notify user every time a successful login occurs across all providers.</p>
                                                    </div>
                                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.send_login_alert ? 'bg-amber-500' : 'bg-slate-300'}`}>
                                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.send_login_alert ? 'translate-x-5' : ''}`}></div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="pt-4 border-t border-slate-100">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Login Webhook URL (Optional)</label>
                                            <input
                                                value={emailPolicies.login_webhook_url || ''}
                                                onChange={(e) => setEmailPolicies(p => ({ ...p, login_webhook_url: e.target.value }))}
                                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                                placeholder="https://api.myapp.com/webhooks/login"
                                            />
                                            <p className="text-[10px] text-slate-400 mt-2 px-1">If set, a POST request will be sent here every time a user successfully logs in.</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* SCHEMA SECTION */}
                {activeSection === 'schema' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">Schema & Data Linking</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Link application tables with the auth users table for automatic foreign key relationships.</p>
                        </div>
                        <div className="space-y-8">
                            <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                                <div className="flex items-center gap-4 mb-8">
                                    <div className="w-0 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><Layers size={20} /></div>
                                    <div>
                                        <h3 className="text-2xl font-black text-slate-900 tracking-tight">Schema Concatenation</h3>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Multi-Table Linking & Foreign Keys</p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                                    {availableTables.map(table => {
                                        const isLinked = linkedTables.includes(table);
                                        return (
                                            <button
                                                key={table}
                                                onClick={() => toggleLinkedTable(table)}
                                                disabled={executing}
                                                className={`p-4 rounded-2xl border flex flex-col items-center gap-3 transition-all ${isLinked ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-white hover:shadow-md'}`}
                                            >
                                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isLinked ? 'bg-white/20' : 'bg-white'}`}>
                                                    {isLinked ? <Link size={18} /> : <Unlink size={18} />}
                                                </div>
                                                <span className="text-xs font-black truncate max-w-full px-2">{table}</span>
                                            </button>
                                        );
                                    })}
                                    {availableTables.length === 0 && <p className="col-span-full text-center text-slate-400 text-xs font-medium py-8">Nenhuma tabela pública disponível para vínculo.</p>}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* STRATEGIES SECTION */}
                {activeSection === 'strategies' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">Identity Strategies</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Configure authentication providers — from OAuth social login to custom identity strategies.</p>
                        </div>
                        <div className="space-y-8">

                            {/* Social Providers */}
                            <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                                <div className="flex items-center gap-4 mb-8">
                                    <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center"><Globe size={20} /></div>
                                    <h3 className="text-2xl font-black text-slate-900 tracking-tight">Social & Enterprise Providers</h3>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    {/* Google */}
                                    <button onClick={() => openProviderConfig('google')} className="flex flex-col items-center gap-4 p-8 border-2 border-indigo-50 bg-indigo-50/20 rounded-[2.5rem] hover:border-indigo-200 transition-all group">
                                        <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg text-rose-600"><Globe size={32} /></div>
                                        <div className="text-center">
                                            <h4 className="font-black text-slate-900">Google Workspace</h4>
                                            <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-50 px-2 py-1 rounded-lg mt-2 inline-block">Configurar</span>
                                        </div>
                                    </button>
                                    {/* GitHub */}
                                    <button onClick={() => openProviderConfig('github')} className="flex flex-col items-center gap-4 p-8 border-2 border-slate-100 bg-slate-50/50 rounded-[2.5rem] hover:border-slate-300 transition-all group">
                                        <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg text-slate-900"><Github size={32} /></div>
                                        <div className="text-center">
                                            <h4 className="font-black text-slate-900">GitHub</h4>
                                            <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-50 px-2 py-1 rounded-lg mt-2 inline-block">Configurar</span>
                                        </div>
                                    </button>
                                </div>
                            </div>
                            {/* Strategy Cards (Custom & System) */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between px-4">
                                    <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.4em]">Active Strategies</h3>
                                    <button onClick={() => setShowNewStrategy(true)} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:bg-indigo-50 px-4 py-2 rounded-xl transition-all flex items-center gap-2"><Plus size={12} /> New Custom Strategy</button>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                                    {Object.keys(strategies)
                                        .filter(stKey => !['google', 'github'].includes(stKey)) // Filter out social providers from this list
                                        .map(stKey => {
                                            const config = strategies[stKey];
                                            const isDefault = ['email'].includes(stKey);

                                            return (
                                                <div key={stKey} className={`relative bg-white border rounded-[2.5rem] p-8 shadow-sm transition-all group ${config.enabled ? 'border-indigo-200' : 'border-slate-200 opacity-70'}`}>
                                                    <div className="flex justify-between items-start mb-6">
                                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg ${config.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                                                            {stKey === 'email' && <Mail size={24} />}
                                                            {stKey === 'cpf' && <CreditCard size={24} />}
                                                            {stKey === 'phone' && <Smartphone size={24} />}
                                                            {!isDefault && <Hash size={24} />}
                                                        </div>
                                                        <button onClick={() => toggleStrategy(stKey)} className={`w-12 h-7 rounded-full p-1 transition-colors ${config.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                                                            <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${config.enabled ? 'translate-x-5' : ''}`}></div>
                                                        </button>
                                                    </div>

                                                    <div className="mb-6">
                                                        <div className="flex items-center justify-between">
                                                            <h4 className="text-xl font-black text-slate-900 capitalize truncate" title={stKey}>{stKey}</h4>
                                                            {!isDefault && (
                                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <button onClick={() => handleDeleteStrategy(stKey)} className="p-1 text-slate-300 hover:text-rose-600"><Trash2 size={12} /></button>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-2">
                                                            {config.rules?.length || 0} Origin Rules • {config.jwt_expiration || '24h'}
                                                        </p>
                                                    </div>

                                                    <button
                                                        onClick={() => {
                                                            setSelectedStrategy(stKey);
                                                            setStrategyConfig({ ...config });
                                                            setEditingStrategyName(stKey);
                                                            setShowConfigModal(true);
                                                        }}
                                                        className="w-full py-4 border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all flex items-center justify-center gap-2"
                                                    >
                                                        <Settings size={14} /> Advanced Config
                                                    </button>
                                                </div>
                                            );
                                        })}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* SECURITY SECTION */}
                {activeSection === 'security' && (
                    <div className="p-10">
                        <div className="mb-8">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tighter">Security & Protection</h2>
                            <p className="text-xs text-slate-400 font-bold mt-1">Brute force protection, identity confirmation policies, and session security.</p>
                        </div>
                        <div className="space-y-8">

                            {/* SECURITY & PROTECTION (Edge Firewall) */}
                            <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                                <div className="flex items-center gap-4 mb-8">
                                    <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center"><ShieldAlert size={20} /></div>
                                    <div>
                                        <h3 className="text-2xl font-black text-slate-900 tracking-tight">Smart Lockout (Edge Firewall)</h3>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Identity-Agnostic Brute Force Protection</p>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Max Attempts (Threshold)</label>
                                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                                            <Target size={16} className="text-rose-400" />
                                            <input
                                                type="number"
                                                min="1"
                                                value={securityConfig.max_attempts}
                                                onChange={(e) => setSecurityConfig({ ...securityConfig, max_attempts: parseInt(e.target.value) })}
                                                className="w-full bg-transparent border-none py-3 px-4 text-sm font-bold text-slate-900 outline-none"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Lockout Duration (Minutes)</label>
                                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                                            <Clock size={16} className="text-indigo-400" />
                                            <input
                                                type="number"
                                                min="1"
                                                value={securityConfig.lockout_minutes}
                                                onChange={(e) => setSecurityConfig({ ...securityConfig, lockout_minutes: parseInt(e.target.value) })}
                                                className="w-full bg-transparent border-none py-3 px-4 text-sm font-bold text-slate-900 outline-none"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-3 mb-8">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Protection Strategy</label>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <button
                                            onClick={() => setSecurityConfig({ ...securityConfig, strategy: 'hybrid' })}
                                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'hybrid' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                                        >
                                            <span className="text-xs font-black uppercase block mb-1">Hybrid (IP + Identifier)</span>
                                            <span className={`text-[10px] ${securityConfig.strategy === 'hybrid' ? 'text-indigo-200' : 'text-slate-400'}`}>Locks IP + Identifier pair. Safest for shared networks.</span>
                                        </button>
                                        <button
                                            onClick={() => setSecurityConfig({ ...securityConfig, strategy: 'ip' })}
                                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'ip' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                                        >
                                            <span className="text-xs font-black uppercase block mb-1">Strict IP</span>
                                            <span className={`text-[10px] ${securityConfig.strategy === 'ip' ? 'text-indigo-200' : 'text-slate-400'}`}>Locks IP address entirely. Good vs distributed Bots.</span>
                                        </button>
                                        <button
                                            onClick={() => setSecurityConfig({ ...securityConfig, strategy: 'identifier' })}
                                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'identifier' || securityConfig.strategy === 'email' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                                        >
                                            <span className="text-xs font-black uppercase block mb-1">Strict Identifier</span>
                                            <span className={`text-[10px] ${securityConfig.strategy === 'identifier' || securityConfig.strategy === 'email' ? 'text-indigo-200' : 'text-slate-400'}`}>Protects specific account/phone/email only.</span>
                                        </button>
                                    </div>
                                </div>

                                {isAggressiveSecurity && (
                                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 mb-6 animate-in fade-in slide-in-from-top-2">
                                        <AlertCircle className="text-amber-600 shrink-0 mt-0.5" size={18} />
                                        <div>
                                            <h4 className="text-xs font-black text-amber-700 uppercase">Warning: Aggressive Thresholds</h4>
                                            <p className="text-[10px] text-amber-600 mt-1 leading-relaxed">
                                                A low max attempt or high duration might lock out legitimate users or administrators. Ensure recovery flows are functional.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                <button onClick={handleSaveSecurity} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                    {executing ? <Loader2 className="animate-spin" size={14} /> : 'Apply Security Policies'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* STRATEGY CONFIG MODAL */}
            {showConfigModal && strategyConfig && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[3.5rem] max-w-2xl w-full p-12 shadow-2xl flex flex-col max-h-[90vh]">
                        <div className="flex justify-between items-center mb-8">
                            <div>
                                <h3 className="text-3xl font-black text-slate-900 capitalize">{selectedStrategy} Settings</h3>
                                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-1">Lifecycle & Security</p>
                            </div>
                            <button onClick={() => setShowConfigModal(false)} className="p-3 bg-slate-50 rounded-full hover:bg-slate-100"><X size={20} /></button>
                        </div>

                        <div className="flex-1 overflow-y-auto space-y-8 pr-2">
                            <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Status</label>
                                    <button
                                        onClick={() => setStrategyConfig({ ...strategyConfig, enabled: !strategyConfig.enabled })}
                                        className={`w-full py-3 rounded-xl border flex items-center justify-center gap-2 transition-all ${strategyConfig.enabled ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                                    >
                                        {strategyConfig.enabled ? <><CheckCircle2 size={16} /> Active Workflow</> : 'Inactive Workflow'}
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">JWT Expiration</label>
                                    <input value={strategyConfig.jwt_expiration || '24h'} onChange={(e) => setStrategyConfig({ ...strategyConfig, jwt_expiration: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Refresh Validity (Days)</label>
                                    <input type="number" value={strategyConfig.refresh_validity_days || 30} onChange={(e) => setStrategyConfig({ ...strategyConfig, refresh_validity_days: parseInt(e.target.value) })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                                </div>
                            </div>

                            {/* EDUCATIONAL SNIPPET FOR CUSTOM STRATEGIES */}
                            {!isOauth(selectedStrategy || '') && selectedStrategy !== 'email' && (
                                <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 shadow-xl overflow-hidden relative group">
                                    <div className="flex justify-between items-center mb-4">
                                        <h4 className="text-emerald-400 font-black text-xs uppercase tracking-widest flex items-center gap-2"><Code size={14} /> Integration Snippet</h4>
                                        <button onClick={() => safeCopy(`
// Universal Login (Any Provider)
const { user, session } = await cascata.auth.signIn({
  provider: '${selectedStrategy}',
  identifier: 'unique_user_id',
  password: 'user_password'
});`)} className="text-slate-500 hover:text-white transition-colors p-1"><Copy size={14} /></button>
                                    </div>
                                    <pre className="text-[10px] font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                                        {`// Universal Login (Any Provider)
const { user, session } = await cascata.auth.signIn({
  provider: '${selectedStrategy}',
  identifier: 'unique_user_id',
  password: 'user_password'
});`}
                                    </pre>
                                    <div className="mt-4 p-3 bg-white/5 rounded-xl border border-white/10 text-[10px] text-slate-400 leading-relaxed">
                                        Use <strong>Universal Login</strong> to authenticate with this custom strategy.
                                        Unlike standard email login, this endpoint accepts any provider identifier you define.
                                    </div>
                                </div>
                            )}

                            {/* RESTORED OTP CONFIGURATION BLOCK (Only for non-OAuth strategies) */}
                            {!isOauth(selectedStrategy || '') && selectedStrategy !== 'email' && (
                                <div className="col-span-2 bg-indigo-50 border border-indigo-100 p-6 rounded-3xl space-y-4">
                                    <h5 className="font-bold text-indigo-900 text-sm flex items-center gap-2"><Hash size={14} /> Custom OTP Configuration</h5>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Code Length</label>
                                            <input
                                                type="number"
                                                value={strategyConfig.otp_config?.length || 6}
                                                onChange={(e) => setStrategyConfig({ ...strategyConfig, otp_config: { ...strategyConfig.otp_config, length: parseInt(e.target.value) } })}
                                                className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Charset</label>
                                            <select
                                                value={strategyConfig.otp_config?.charset || 'numeric'}
                                                onChange={(e) => setStrategyConfig({ ...strategyConfig, otp_config: { ...strategyConfig.otp_config, charset: e.target.value } })}
                                                className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none"
                                            >
                                                <option value="numeric">Numeric (0-9)</option>
                                                <option value="alphanumeric">Alphanumeric (A-Z, 0-9)</option>
                                                <option value="alpha">Alpha (A-Z)</option>
                                                <option value="hex">Hex (0-9, A-F)</option>
                                            </select>
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Identifier Regex (Backend Validation)</label>
                                            <input
                                                value={strategyConfig.otp_config?.regex_validation || ''}
                                                onChange={(e) => setStrategyConfig({ ...strategyConfig, otp_config: { ...strategyConfig.otp_config, regex_validation: e.target.value } })}
                                                placeholder="e.g. ^\d{11}$ (CPF)"
                                                className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-mono font-bold"
                                            />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">OTP Webhook URL</label>
                                            <input
                                                value={strategyConfig.webhook_url || ''}
                                                onChange={(e) => setStrategyConfig({ ...strategyConfig, webhook_url: e.target.value })}
                                                placeholder="https://n8n.webhook/send-otp"
                                                className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold"
                                            />
                                        </div>
                                    </div>

                                    {/* TEMPLATE BINDING (i18n) */}
                                    {Object.keys(messagingTemplates).length > 0 && (
                                        <div className="mt-2 pt-4 border-t border-indigo-200/50 space-y-3">
                                            <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">OTP Message Template (i18n Library)</label>
                                            <select
                                                value={strategyConfig.template_bindings?.otp_challenge || ''}
                                                onChange={(e) => setStrategyConfig({
                                                    ...strategyConfig,
                                                    template_bindings: { ...(strategyConfig.template_bindings || {}), otp_challenge: e.target.value || undefined }
                                                })}
                                                className="w-full bg-white border-none rounded-xl py-2.5 px-3 text-xs font-bold outline-none shadow-sm"
                                            >
                                                <option value="">System Default (No i18n)</option>
                                                {Object.values(messagingTemplates)
                                                    .filter((t: any) => t.type === 'otp_challenge')
                                                    .map((t: any) => (
                                                        <option key={t.id} value={t.id}>{t.name} ({Object.keys(t.variants).join(', ')})</option>
                                                    ))
                                                }
                                            </select>
                                            {strategyConfig.template_bindings?.otp_challenge && messagingTemplates[strategyConfig.template_bindings.otp_challenge] && (
                                                <div className="bg-white/80 rounded-xl p-3 border border-indigo-100">
                                                    <p className="text-[9px] font-black text-indigo-500 uppercase tracking-widest mb-1">
                                                        Preview ({messagingTemplates[strategyConfig.template_bindings.otp_challenge].default_language})
                                                    </p>
                                                    <p className="text-[10px] text-slate-600 font-mono leading-relaxed whitespace-pre-wrap max-h-20 overflow-y-auto">
                                                        {messagingTemplates[strategyConfig.template_bindings.otp_challenge].variants?.[messagingTemplates[strategyConfig.template_bindings.otp_challenge].default_language]?.body || '(empty body)'}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* BANK-GRADE SECURITY (OTP ENFORCEMENT) */}
                            <div className="col-span-2 bg-rose-50 border border-rose-100 p-6 rounded-3xl space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h5 className="font-bold text-rose-900 text-sm flex items-center gap-2">🔐 Bank-Grade Security Lock</h5>
                                        <p className="text-[10px] text-rose-700 font-bold mt-1">Require OTP challenge for sensitive updates (e.g., password, new identity)</p>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" checked={strategyConfig.require_otp_on_update || false} onChange={(e) => setStrategyConfig({ ...strategyConfig, require_otp_on_update: e.target.checked })} />
                                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-600"></div>
                                    </label>
                                </div>

                                {strategyConfig.require_otp_on_update && (
                                    <div className="pt-4 border-t border-rose-200/50">
                                        <label className="text-[9px] font-black text-rose-800 uppercase tracking-widest">OTP Dispatch Mode</label>
                                        <select
                                            value={strategyConfig.otp_dispatch_mode || 'delegated'}
                                            onChange={(e) => setStrategyConfig({ ...strategyConfig, otp_dispatch_mode: e.target.value })}
                                            className="w-full mt-2 bg-white border-none rounded-xl py-3 px-4 text-xs font-bold outline-none text-slate-700 shadow-sm"
                                        >
                                            <option value="delegated">Delegated (Frontend prompts User to choose Channel)</option>
                                            <option value="auto_current">Auto-Current (Send OTP to the Identity being updated)</option>
                                            <option value="auto_primary">Auto-Primary (Send OTP to Account's root email)</option>
                                        </select>
                                        <p className="text-[9px] text-rose-600/70 font-semibold mt-2">
                                            Determines how the API routes the security code when an update is blocked.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-3">
                                <div className="flex flex-col gap-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Authorized Origins (CORS/Redirects)</label>
                                    <div className="flex gap-2">
                                        <input
                                            value={strategyConfig.newRule || ''}
                                            onChange={(e) => setStrategyConfig({ ...strategyConfig, newRule: e.target.value })}
                                            placeholder="https://meu-app.com"
                                            className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-mono font-bold outline-none focus:ring-2 focus:ring-indigo-500/20"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    addRuleToStrategy(strategyConfig.newRule || '', false);
                                                }
                                            }}
                                        />
                                        <button onClick={() => {
                                            addRuleToStrategy(strategyConfig.newRule || '', false);
                                        }} className="px-5 py-3 bg-indigo-50 text-indigo-600 font-bold text-[10px] uppercase rounded-xl hover:bg-indigo-100 transition-colors shrink-0">Add Origin</button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    {strategyConfig.rules?.map((rule: any, idx: number) => (
                                        <div key={idx} className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                                            <span className="text-xs font-mono font-bold text-slate-600">{rule.origin}</span>
                                            <button onClick={() => removeRuleFromStrategy(rule.origin)} className="text-rose-400 hover:text-rose-600"><X size={14} /></button>
                                        </div>
                                    ))}
                                    {(!strategyConfig.rules || strategyConfig.rules.length === 0) && <p className="text-xs text-slate-400 italic">No origin rules defined (Public).</p>}
                                </div>
                            </div>
                        </div>

                        <div className="pt-8 border-t border-slate-100 flex justify-end gap-4 mt-auto">
                            <button onClick={() => setShowConfigModal(false)} className="px-6 py-4 rounded-2xl text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50">Cancel</button>
                            <button onClick={handleSaveStrategyConfig} className="px-8 py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700">Save Changes</button>
                        </div>
                    </div>
                </div>
            )
            }

            {/* CREATE USER MODAL */}
            {
                showCreateUser && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl relative">
                            <button onClick={() => setShowCreateUser(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900"><X size={24} /></button>
                            <h3 className="text-2xl font-black text-slate-900 mb-6">Create User</h3>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Identifier (Email/Phone)</label>
                                    <input value={createUserForm.identifier} onChange={(e) => setCreateUserForm({ ...createUserForm, identifier: e.target.value })} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none" placeholder="user@example.com" />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
                                    <input type="password" value={createUserForm.password} onChange={(e) => setCreateUserForm({ ...createUserForm, password: e.target.value })} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none" placeholder="••••••••" />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Provider</label>
                                    <select value={createUserForm.provider} onChange={(e) => setCreateUserForm({ ...createUserForm, provider: e.target.value })} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none">
                                        <option value="email">Email</option>
                                        <option value="phone">Phone</option>
                                        <option value="cpf">CPF</option>
                                        <option value="gamertag">Gamertag</option>
                                    </select>
                                </div>
                                <button onClick={handleCreateUser} disabled={executing} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl mt-4 hover:bg-indigo-700 transition-all">
                                    {executing ? <Loader2 className="animate-spin mx-auto" /> : 'Create User'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* NEW STRATEGY MODAL */}
            {
                showNewStrategy && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] w-full max-w-sm p-10 shadow-2xl relative">
                            <h3 className="text-xl font-black text-slate-900 mb-4">Add Custom Strategy</h3>
                            <input autoFocus value={newStrategyName} onChange={(e) => setNewStrategyName(e.target.value)} placeholder="Strategy Name (e.g. biometrics)" className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none mb-6" />
                            <div className="flex gap-4">
                                <button onClick={() => setShowNewStrategy(false)} className="flex-1 py-3 text-slate-400 font-bold text-xs uppercase hover:bg-slate-50 rounded-xl">Cancel</button>
                                <button onClick={handleCreateCustomStrategy} className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-indigo-700">Create</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* PROVIDER CONFIG MODAL */}
            {
                showProviderConfig && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl relative">
                            <button onClick={() => setShowProviderConfig(null)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
                            <div className="flex flex-col items-center mb-6">
                                <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl mb-4">
                                    {showProviderConfig === 'github' ? <Github size={32} /> : <Globe size={32} />}
                                </div>
                                <h3 className="text-2xl font-black text-slate-900 tracking-tight capitalize">Configure {showProviderConfig}</h3>
                                <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">OAuth Integration</p>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client ID</label>
                                    <input
                                        value={providerConfig.client_id || ''}
                                        onChange={(e) => setProviderConfig({ ...providerConfig, client_id: e.target.value })}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono text-indigo-600"
                                        placeholder="Received from Provider"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client Secret</label>
                                    <input
                                        type="password"
                                        value={providerConfig.client_secret || ''}
                                        onChange={(e) => setProviderConfig({ ...providerConfig, client_secret: e.target.value })}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono"
                                        placeholder="••••••••••••••••"
                                    />
                                </div>

                                <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block flex items-center gap-1"><Link size={10} /> Callback URL (Redirect URI)</label>
                                    <div className="flex items-center gap-2 bg-white border border-slate-200 p-2 rounded-xl">
                                        <code className="text-[10px] text-slate-600 font-mono truncate flex-1">{getCallbackUrl()}</code>
                                        <button onClick={() => safeCopy(getCallbackUrl())} className="p-1.5 hover:bg-slate-100 rounded-lg text-indigo-500"><Copy size={12} /></button>
                                    </div>
                                    <p className="text-[9px] text-slate-400 mt-2 px-1 leading-tight">
                                        Add this URL to your OAuth App settings in the Provider's Developer Console.
                                    </p>
                                </div>

                                <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={providerConfig.auto_verify || false}
                                            onChange={(e) => setProviderConfig({ ...providerConfig, auto_verify: e.target.checked })}
                                            className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                        />
                                        <div>
                                            <span className="text-xs font-bold text-slate-700">Auto-Verify Identities</span>
                                            <p className="text-[9px] text-slate-400 leading-tight mt-0.5">
                                                Automatically mark identities from this provider as verified upon account creation.
                                            </p>
                                        </div>
                                    </label>
                                </div>

                                <button onClick={handleSaveProviderConfig} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 mt-2">
                                    <CheckCircle2 size={16} /> Save Configuration
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* DELETE CONFIRM */}
            {
                showDeleteModal && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] w-full max-w-sm p-10 shadow-2xl text-center border border-rose-100">
                            <AlertCircle size={48} className="text-rose-500 mx-auto mb-4" />
                            <h3 className="text-xl font-black text-slate-900 mb-2">Delete User?</h3>
                            <p className="text-xs text-slate-500 mb-6">To confirm, type the User UUID below.</p>
                            <code className="block bg-slate-100 p-2 rounded-lg text-[10px] font-mono mb-4 text-slate-600 select-all">{showDeleteModal.id}</code>
                            <input value={deleteConfirmUuid} onChange={(e) => setDeleteConfirmUuid(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold text-center outline-none mb-6 focus:ring-4 focus:ring-rose-500/10" />
                            <div className="flex gap-4">
                                <button onClick={() => setShowDeleteModal(null)} className="flex-1 py-3 text-slate-400 font-bold text-xs uppercase hover:bg-slate-50 rounded-xl">Cancel</button>
                                <button onClick={handleDeleteUser} disabled={deleteConfirmUuid !== showDeleteModal.id || executing} className="flex-1 py-3 bg-rose-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-rose-700 disabled:opacity-50">Delete</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* USER DETAIL MODAL (LINK IDENTITIES) */}
            {
                showUserModal && selectedUser && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3.5rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-100 flex flex-col max-h-[90vh]">
                            <header className="flex justify-between items-start mb-8">
                                <div>
                                    <h3 className="text-3xl font-black text-slate-900">User Details</h3>
                                    <div className="flex items-center gap-2 mt-2">
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${selectedUser.banned ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>{selectedUser.banned ? 'Banned' : 'Active'}</span>
                                        <span className="text-xs text-slate-400 font-mono">{selectedUser.id}</span>
                                    </div>
                                </div>
                                <button onClick={() => setShowUserModal(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400"><X size={24} /></button>
                            </header>

                            <div className="flex-1 overflow-y-auto space-y-8">
                                {/* IDENTITIES LIST */}
                                <div className="space-y-4">
                                    <div className="flex justify-between items-center">
                                        <h4 className="text-sm font-black text-slate-900">Linked Identities</h4>
                                        <button onClick={() => setShowLinkIdentity(true)} className="text-[10px] font-bold text-indigo-600 uppercase hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1"><Plus size={12} /> Link New</button>
                                    </div>

                                    {showLinkIdentity && (
                                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 animate-in slide-in-from-top-2 space-y-3">
                                            <div className="grid grid-cols-3 gap-3">
                                                <select value={linkIdentityForm.provider} onChange={e => setLinkIdentityForm({ ...linkIdentityForm, provider: e.target.value })} className="bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none">
                                                    {Object.keys(strategies).filter(k => strategies[k].enabled).map(k => <option key={k} value={k}>{k}</option>)}
                                                </select>
                                                <input value={linkIdentityForm.identifier} onChange={e => setLinkIdentityForm({ ...linkIdentityForm, identifier: e.target.value })} placeholder="Identifier" className="col-span-2 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none" />
                                            </div>
                                            <input type="password" value={linkIdentityForm.password} onChange={e => setLinkIdentityForm({ ...linkIdentityForm, password: e.target.value })} placeholder="Password (Optional)" className="w-full bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none" />
                                            <div className="flex gap-2 justify-end">
                                                <button onClick={() => setShowLinkIdentity(false)} className="text-[10px] font-bold text-slate-400 px-3 py-2">Cancel</button>
                                                <button onClick={handleLinkIdentity} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-bold uppercase hover:bg-indigo-700">Link</button>
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        {selectedUser.identities?.map((id: any) => (
                                            <div key={id.id} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-sm text-indigo-600">
                                                        {id.provider === 'email' ? <Mail size={16} /> : id.provider === 'phone' ? <Smartphone size={16} /> : <Globe size={16} />}
                                                    </div>
                                                    <div>
                                                        <p className="text-xs font-bold text-slate-700">{id.identifier}</p>
                                                        <p className="text-[10px] text-slate-400 font-bold uppercase">{id.provider}</p>
                                                    </div>
                                                </div>
                                                <button onClick={() => handleUnlinkIdentity(id.id)} className="p-2 text-slate-300 hover:text-rose-600 hover:bg-white rounded-lg transition-all" title="Unlink"><Unlink size={16} /></button>
                                                {id.verified_at ? (
                                                    <span className="text-[9px] font-black text-emerald-500 bg-emerald-50 px-2 py-1 rounded-lg uppercase tracking-widest flex items-center gap-1"><CheckCircle2 size={10} /> Verified</span>
                                                ) : (
                                                    <span className="text-[9px] font-black text-amber-500 bg-amber-50 px-2 py-1 rounded-lg uppercase tracking-widest flex items-center gap-1"><AlertCircle size={10} /> Unverified</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* ACTIVE SESSIONS */}
                                <div className="space-y-4 pt-4 border-t border-slate-100">
                                    <div className="flex justify-between items-center">
                                        <h4 className="text-sm font-black text-slate-900">Active Sessions</h4>
                                        {activeSessions.length > 1 && (
                                            <button onClick={handleRevokeOtherSessions} disabled={executing} className="text-[10px] font-bold text-rose-600 uppercase hover:bg-rose-50 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1"><Ban size={12} /> Revoke All Others</button>
                                        )}
                                    </div>
                                    {loadingSessions ? (
                                        <div className="flex justify-center py-4"><Loader2 className="animate-spin text-indigo-400" size={20} /></div>
                                    ) : activeSessions.length === 0 ? (
                                        <p className="text-xs text-slate-400 italic">No active sessions found.</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {activeSessions.map((s: any) => (
                                                <div key={s.id} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100 gap-4">
                                                    <div className="flex items-start gap-3 overflow-hidden">
                                                        <div className="w-8 h-8 shrink-0 bg-white rounded-lg flex items-center justify-center shadow-sm text-indigo-600 mt-0.5">
                                                            <Server size={14} />
                                                        </div>
                                                        <div className="overflow-hidden">
                                                            <p className="text-xs font-bold text-slate-700 truncate min-w-[100px]" title={s.user_agent}>{s.user_agent || 'Unknown Device'}</p>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <span className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-mono truncate">{s.ip_address || 'IP Unknown'}</span>
                                                                <span className="text-[9px] text-slate-400 font-bold uppercase shrink-0">Created: {new Date(s.created_at).toLocaleDateString()}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <button onClick={() => handleRevokeSession(s.id)} disabled={executing} className="shrink-0 p-2 text-rose-400 hover:text-rose-600 hover:bg-white rounded-lg transition-all" title="Revoke Device">
                                                        <X size={16} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* ACTIONS */}
                                <div className="pt-6 border-t border-slate-100 flex gap-4">
                                    <button onClick={() => handleBlockUser(selectedUser)} className={`flex-1 py-4 rounded-2xl text-xs font-black uppercase tracking-widest transition-all ${selectedUser.banned ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}>
                                        {selectedUser.banned ? 'Unban User' : 'Ban User'}
                                    </button>
                                    <button onClick={() => { setShowDeleteModal({ id: selectedUser.id }); }} className="flex-1 py-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-rose-600 hover:text-white transition-all">
                                        Delete User
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Verify Password Modal (For Revealing Sensitive Data) */}
            {
                showVerifyModal && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-slate-200">
                            <Lock size={40} className="mx-auto text-slate-900 mb-6" />
                            <h3 className="text-xl font-black text-slate-900 mb-2">Confirmação de Segurança</h3>
                            <p className="text-xs text-slate-500 font-bold mb-8">Digite sua senha administrativa para revelar os dados sensíveis dos usuários.</p>
                            <form onSubmit={(e) => { e.preventDefault(); handleVerifyPassword(); }}>
                                <input
                                    type="password"
                                    autoFocus
                                    value={verifyPassword}
                                    onChange={e => setVerifyPassword(e.target.value)}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                                    placeholder="••••••••"
                                />
                                <button type="submit" disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                    {executing ? <Loader2 className="animate-spin" size={16} /> : 'Confirmar Acesso'}
                                </button>
                            </form>
                            <button onClick={() => { setShowVerifyModal(false); setVerifyPassword(''); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
                        </div>
                    </div>
                )
            }

            {/* APP CLIENT CREATION MODAL */}
            {
                showAppClientModal && (
                    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[1000] flex justify-center items-center p-4">
                        <div className="bg-white max-w-lg w-full rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                            <div className="p-10 border-b border-slate-100">
                                <h2 className="text-2xl font-black text-slate-900">Create App Client</h2>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-2">Generate a scoped Identity-Aware Key</p>
                            </div>
                            <div className="p-10 space-y-6 bg-slate-50/50">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client Name</label>
                                    <input
                                        autoFocus
                                        value={newAppClientConfig.name}
                                        onChange={e => setNewAppClientConfig({ ...newAppClientConfig, name: e.target.value })}
                                        placeholder="e.g. Driver Mobile App"
                                        className="w-full bg-white border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Specific Site URL (Redirect)</label>
                                    <input
                                        value={newAppClientConfig.site_url}
                                        onChange={e => setNewAppClientConfig({ ...newAppClientConfig, site_url: e.target.value })}
                                        placeholder="exp://driver.app"
                                        className="w-full bg-white border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Allowed Origins (CORS)</label>
                                    <input
                                        value={newAppClientConfig.allowed_origins}
                                        onChange={e => setNewAppClientConfig({ ...newAppClientConfig, allowed_origins: e.target.value })}
                                        placeholder="https://driver.com, exp://driver.app"
                                        className="w-full bg-white border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                    />
                                </div>
                            </div>
                            <div className="p-6 border-t border-slate-100 flex justify-end gap-3 bg-white">
                                <button onClick={() => setShowAppClientModal(false)} className="px-6 py-3 rounded-2xl text-xs font-black text-slate-500 uppercase tracking-widest hover:bg-slate-50 transition-all">Cancel</button>
                                <button onClick={handleSaveAppClient} disabled={executing || !newAppClientConfig.name} className="bg-indigo-600 text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-200 disabled:opacity-50">Create Key</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* CREATE TEMPLATE MODAL */}
            {
                showCreateTemplateModal && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                        <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl relative">
                            <button onClick={() => setShowCreateTemplateModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900"><X size={24} /></button>
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><LayoutTemplate size={24} /></div>
                                <div>
                                    <h3 className="text-xl font-black text-slate-900">New Message Template</h3>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">i18n Reusable Template</p>
                                </div>
                            </div>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Template Name</label>
                                    <input
                                        autoFocus
                                        value={newTemplateForm.name}
                                        onChange={(e) => setNewTemplateForm({ ...newTemplateForm, name: e.target.value })}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                        placeholder="e.g. OTP SMS Code"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Message Type</label>
                                    <select
                                        value={newTemplateForm.type}
                                        onChange={(e) => setNewTemplateForm({ ...newTemplateForm, type: e.target.value })}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                    >
                                        <option value="otp_challenge">OTP Challenge</option>
                                        <option value="confirmation">Confirmation</option>
                                        <option value="recovery">Recovery</option>
                                        <option value="magic_link">Magic Link</option>
                                        <option value="login_alert">Login Alert</option>
                                        <option value="welcome">Welcome</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Default Language (ISO Code)</label>
                                    <input
                                        value={newTemplateForm.default_language}
                                        onChange={(e) => setNewTemplateForm({ ...newTemplateForm, default_language: e.target.value })}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                        placeholder="en-US"
                                    />
                                    <p className="text-[9px] text-slate-400 px-1">ISO 639 code. Examples: en-US, pt-BR, es-ES, fr-FR, de-DE, ja-JP</p>
                                </div>
                                <button
                                    onClick={handleCreateTemplate}
                                    disabled={!newTemplateForm.name}
                                    className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl mt-2 hover:bg-indigo-700 transition-all disabled:opacity-50"
                                >
                                    Create Template
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
};

export default AuthConfig;
