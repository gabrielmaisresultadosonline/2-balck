
    // --- WinBack Logic ---
    let wbCampaigns = [];
    let wbSelectedContacts = new Set();
    
    window.openNewWinbackCampaign = function() {
        const modal = document.getElementById('winbackModal');
        if(!modal) return;
        
        // Reset form
        document.getElementById('wbCrmColumn').value = '';
        document.getElementById('wbCrmCount').innerText = '';
        document.getElementById('wbManualList').innerHTML = 'Carregando conversas...';
        document.getElementById('wbManualCount').innerText = '0';
        document.getElementById('wbMessage').value = '';
        document.getElementById('wbAiEnabled').checked = false;
        toggleWbAi(false);
        wbSelectedContacts.clear();
        
        // Populate CRM Columns
        const colSelect = document.getElementById('wbCrmColumn');
        colSelect.innerHTML = '<option value="">Selecione uma coluna...</option>';
        columns.forEach(c => {
             const opt = document.createElement('option');
             opt.value = c.id;
             opt.innerText = c.title;
             colSelect.appendChild(opt);
        });
        
        // Populate Flows
        const flowSelect = document.getElementById('wbFlowSelect');
        flowSelect.innerHTML = '<option value="">Selecione um fluxo...</option>';
        if (allFlows && Array.isArray(allFlows)) {
            allFlows.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.innerText = f.name;
                flowSelect.appendChild(opt);
            });
        }
        
        switchWbTab('crm');
        modal.style.display = 'block';
    };

    window.switchWbTab = function(tab) {
        document.querySelectorAll('#winbackModal .nav-tab').forEach(b => b.classList.remove('active'));
        // Find the button that clicked or matching tab... simplified:
        const buttons = document.querySelectorAll('#winbackModal .nav-tab');
        if (tab === 'crm') buttons[0].classList.add('active');
        if (tab === 'manual') buttons[1].classList.add('active');
        if (tab === 'upload') buttons[2].classList.add('active');
        
        document.getElementById('wbTabCrm').style.display = 'none';
        document.getElementById('wbTabManual').style.display = 'none';
        document.getElementById('wbTabUpload').style.display = 'none';
        
        if(tab === 'crm') {
            document.getElementById('wbTabCrm').style.display = 'block';
        } else if (tab === 'manual') {
            document.getElementById('wbTabManual').style.display = 'block';
            renderWbManualList();
        } else if (tab === 'upload') {
            document.getElementById('wbTabUpload').style.display = 'block';
        }
    };
    
    window.handleWbFileUpload = function(input) {
        const file = input.files[0];
        if(!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            let addedCount = 0;
            
            if(file.name.toLowerCase().endsWith('.csv')) {
                const lines = text.split('\n');
                lines.forEach(line => {
                    const parts = line.split(/[,;]/);
                    parts.forEach(p => {
                        const clean = p.replace(/\D/g, '');
                        if(clean.length >= 10 && clean.length <= 15) {
                            if(!wbSelectedContacts.has(clean + '@c.us')) {
                                wbSelectedContacts.add(clean + '@c.us');
                                addedCount++;
                            }
                        }
                    });
                });
            } else if (file.name.toLowerCase().endsWith('.vcf')) {
                const regex = /TEL;.*:(.*)/g;
                let match;
                while ((match = regex.exec(text)) !== null) {
                    const clean = match[1].replace(/\D/g, '');
                    if(clean.length >= 10 && clean.length <= 15) {
                        if(!wbSelectedContacts.has(clean + '@c.us')) {
                            wbSelectedContacts.add(clean + '@c.us');
                            addedCount++;
                        }
                    }
                }
            }
            
            document.getElementById('wbUploadResult').style.display = 'block';
            document.getElementById('wbUploadCount').innerText = addedCount + ' novos (' + wbSelectedContacts.size + ' total)';
            
            const list = document.getElementById('wbUploadList');
            list.innerHTML = '';
            wbSelectedContacts.forEach(id => {
                const div = document.createElement('div');
                div.innerText = id.replace('@c.us', '');
                list.appendChild(div);
            });
        };
        reader.readAsText(file);
    };

    function renderWbManualList() {
        const list = document.getElementById('wbManualList');
        list.innerHTML = '';
        const chats = Object.values(allChatsData); // Global chats
        // Sort by time
        chats.sort((a,b) => (Number(b && b.timestamp) || 0) - (Number(a && a.timestamp) || 0));
        
        chats.forEach(chat => {
            const div = document.createElement('div');
            div.style.padding = '8px';
            div.style.borderBottom = '1px solid #f0f0f0';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.cursor = 'pointer';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = wbSelectedContacts.has(chat.id);
            checkbox.style.marginRight = '10px';
            
            const name = document.createElement('span');
            name.innerText = chat.name || chat.id;
            
            div.onclick = (e) => {
                if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
                if(checkbox.checked) wbSelectedContacts.add(chat.id);
                else wbSelectedContacts.delete(chat.id);
                document.getElementById('wbManualCount').innerText = wbSelectedContacts.size;
            };
            
            div.prepend(checkbox);
            div.appendChild(name);
            list.appendChild(div);
        });
    }

    window.toggleWbContent = function(val) {
        document.getElementById('wbContentText').style.display = val === 'text' ? 'block' : 'none';
        document.getElementById('wbContentFlow').style.display = val === 'flow' ? 'block' : 'none';
    };

    window.toggleWbAi = function(enabled) {
        document.getElementById('wbAiOptions').style.display = enabled ? 'block' : 'none';
    };

    window.startWinbackCampaign = function() {
        // Collect data
        const tabCrm = document.getElementById('wbTabCrm').style.display !== 'none';
        let targets = [];
        
        if (tabCrm) {
            const colId = document.getElementById('wbCrmColumn').value;
            if(!colId) return alert('Selecione uma coluna CRM');
            targets = Object.values(allChatsData).filter(c => c.status === colId).map(c => c.id);
        } else {
            targets = Array.from(wbSelectedContacts);
        }
        
        if(targets.length === 0) return alert('Nenhum contato selecionado');
        if(targets.length > 70) return alert('Limite de 70 contatos excedido (Segurança Anti-Bloqueio).');
        
        const contentType = document.getElementById('wbContentType').value;
        const message = document.getElementById('wbMessage').value;
        const flowId = document.getElementById('wbFlowSelect').value;
        
        if(contentType === 'text' && !message.trim()) return alert('Digite a mensagem.');
        if(contentType === 'flow' && !flowId) return alert('Selecione um fluxo.');
        
        const aiEnabled = document.getElementById('wbAiEnabled').checked;
        const aiGoal = document.getElementById('wbAiGoal').value;
        const aiContext = document.getElementById('wbAiContext').value;

        const payload = {
            sessionId,
            targets,
            config: {
                type: contentType,
                content: contentType === 'text' ? message : flowId,
                ai: aiEnabled ? { goal: aiGoal, context: aiContext } : null
            }
        };
        
        const btn = document.getElementById('wbStartBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Criando...';
        
        socket.emit('create-winback-campaign', payload);
    };
    
    // Socket Listeners
    socket.on('winback-campaign-created', (data) => {
        if (data.success) {
            document.getElementById('winbackModal').style.display = 'none';
            alert('Campanha WinBack criada com sucesso!');
        } else {
            alert('Erro ao criar campanha: ' + (data.error || 'Erro desconhecido'));
        }
        const btn = document.getElementById('wbStartBtn');
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane"></i> Iniciar Campanha';
        }
    });

    socket.on('winback-stats-update', (stats) => {
        if(document.getElementById('wbStatMonthly')) document.getElementById('wbStatMonthly').innerText = stats.totalSent || 0; // Show Total Sent This Month
        if(document.getElementById('wbStatWeekly')) document.getElementById('wbStatWeekly').innerText = stats.weekly || 0; // Not implemented yet, placeholder
        if(document.getElementById('wbStatToday')) document.getElementById('wbStatToday').innerText = stats.today || 0; // Not implemented yet, placeholder
    });
    
    socket.on('winback-campaigns-list', (list) => {
        wbCampaigns = list;
        renderWbCampaigns();
    });
    
    function renderWbCampaigns() {
        const container = document.getElementById('wbCampaignsList');
        if(!container) return;
        container.innerHTML = '';
        if(!wbCampaigns.length) {
            container.innerHTML = '<div style="text-align: center; color: #9ca3af; padding: 20px;">Nenhuma campanha encontrada.</div>';
            return;
        }
        wbCampaigns.forEach(c => {
             const div = document.createElement('div');
             div.style.background = '#f9fafb';
             div.style.border = '1px solid #eee';
             div.style.borderRadius = '8px';
             div.style.padding = '15px';
             div.style.marginBottom = '10px';
             div.style.display = 'flex';
             div.style.justifyContent = 'space-between';
             div.style.alignItems = 'center';
             
             const progress = Math.round((c.sentCount / c.totalCount) * 100);
             const statusColor = c.status === 'completed' ? 'green' : (c.status === 'paused' ? 'orange' : 'blue');
             const statusLabel = c.status === 'completed' ? 'Concluída' : (c.status === 'paused' ? 'Pausada' : 'Em andamento');
             
             div.innerHTML = `
                <div>
                    <div style="font-weight: 600; color: #374151;">Campanha #${c.id.slice(0,6)}</div>
                    <div style="font-size: 0.85rem; color: #666; margin-top: 5px;">
                        ${new Date(c.createdAt).toLocaleDateString()} - ${c.config.type === 'text' ? 'Texto' : 'Fluxo'}
                        ${c.config.ai ? '<span style="background:#dbeafe; color:#1e40af; padding:2px 6px; border-radius:4px; font-size:0.7rem; margin-left:5px;">IA Ativa</span>' : ''}
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="font-weight: bold; color: ${statusColor}; font-size: 0.9rem;">${statusLabel}</div>
                    <div style="font-size: 0.85rem; color: #666; margin-top: 2px;">${c.sentCount}/${c.totalCount} enviados (${progress}%)</div>
                </div>
             `;
             container.appendChild(div);
        });
    }

    // Initial Request
    if (socket && sessionId) {
        socket.emit('get-winback-stats', sessionId);
    }
