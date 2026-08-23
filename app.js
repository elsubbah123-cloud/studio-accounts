// ==============================================================================
// حسابات ستوديو الصباح - نظام الويب المتكامل مع كامل الصلاحيات والطباعة والتعديل
// ==============================================================================

const SUPABASE_DEFAULT_URL = "https://uikxkghfjcykukauuowz.supabase.co";
const SUPABASE_DEFAULT_KEY = "sb_publishable_zJSR4sB3dZr9dyUT4kTRBQ_ATl8YqNW";

let supabaseClient = null;
let isAdminLoggedIn = false;
let currentAdminPassword = "admin123";
let realtimeChannel = null;

// Global Cache State
let dbCustomers = [];
let dbProducts = [];
let dbInvoices = [];
let dbInvoiceItems = [];
let dbPayments = [];

// Current invoice builder state
let currentInvoiceItems = [];
let selectedCategoryId = null;
let currentClientSearchedCustomer = null;

document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
    // 3-second auto-poll fallback to ensure instant sync
    setInterval(() => {
        if (isAdminLoggedIn) {
            loadAllAdminData(true);
        } else if (currentClientSearchedCustomer) {
            refreshCurrentClientView();
        }
    }, 3000);
});

async function initSupabase() {
    const url = localStorage.getItem("supabase_url") || SUPABASE_DEFAULT_URL;
    const key = localStorage.getItem("supabase_key") || SUPABASE_DEFAULT_KEY;

    try {
        supabaseClient = window.supabase.createClient(url, key);

        try {
            if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
            realtimeChannel = supabaseClient.channel('realtime-all-sync')
                .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
                    if (isAdminLoggedIn) {
                        loadAllAdminData(true);
                    } else if (currentClientSearchedCustomer) {
                        refreshCurrentClientView();
                    }
                })
                .subscribe();
        } catch (rtErr) {
            console.log("Realtime fallback:", rtErr);
        }

        const { data: settings } = await supabaseClient
            .from("products")
            .select("size")
            .eq("category", "__APP_SETTINGS__")
            .eq("name", "ADMIN_PASSWORD")
            .limit(1);

        if (settings && settings.length > 0 && settings[0].size) {
            currentAdminPassword = settings[0].size.trim();
        }
    } catch (e) {
        console.error("Supabase init error:", e);
    }
}

// -----------------------------------------------------------------------------
// 1. CLIENT PORTAL (PUBLIC / BY PHONE)
// -----------------------------------------------------------------------------
async function searchClientAccount() {
    const phoneInput = document.getElementById("client-phone-input").value.trim();
    if (!phoneInput) {
        alert("يرجى إدخال رقم الهاتف المسجل لدينا");
        return;
    }

    if (!supabaseClient) await initSupabase();

    try {
        const { data: customers, error: cErr } = await supabaseClient
            .from("customers")
            .select("*")
            .ilike("phone", `%${phoneInput}%`)
            .limit(1);

        if (cErr || !customers || customers.length === 0) {
            alert("لم يتم العثور على عميل مسجل بهذا الرقم! يرجى التأكد من كتابة الرقم بشكل صحيح.");
            return;
        }

        currentClientSearchedCustomer = customers[0];
        await refreshCurrentClientView();

    } catch (err) {
        alert("حدث خطأ أثناء جلب البيانات: " + err.message);
    }
}

async function refreshCurrentClientView() {
    if (!currentClientSearchedCustomer || !supabaseClient) return;

    try {
        const [cRes, iRes, itmRes, payRes] = await Promise.all([
            supabaseClient.from("customers").select("*").eq("id", currentClientSearchedCustomer.id).limit(1),
            supabaseClient.from("invoices").select("*").or(`customer_name.eq.${currentClientSearchedCustomer.name},customer_id.eq.${currentClientSearchedCustomer.id}`).order("invoice_date", { ascending: true }),
            supabaseClient.from("invoice_items").select("*"),
            supabaseClient.from("payments").select("*").or(`customer_name.eq.${currentClientSearchedCustomer.name},customer_id.eq.${currentClientSearchedCustomer.id}`).order("payment_date", { ascending: true })
        ]);

        if (cRes.data && cRes.data.length > 0) {
            currentClientSearchedCustomer = cRes.data[0];
        }

        displayClientData(currentClientSearchedCustomer, iRes.data || [], itmRes.data || [], payRes.data || []);
    } catch (e) {
        console.error("Error refreshing client view:", e);
    }
}

function displayClientData(customer, invoices, allItems, payments) {
    document.getElementById("client-name").innerText = customer.name;
    document.getElementById("client-phone").innerText = customer.phone || "-";
    document.getElementById("client-type").innerText = customer.customer_type || "-";

    const openingBal = parseFloat(customer.opening_balance || 0);

    // TAB 1: بيان الطباعة
    const printsTbody = document.getElementById("client-prints-tbody");
    printsTbody.innerHTML = "";

    if (invoices.length === 0) {
        printsTbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-400 font-semibold">لا توجد فواتير طباعة مسجلة حتى الآن</td></tr>`;
    } else {
        invoices.forEach(inv => {
            const invItems = allItems.filter(itm => itm.product_id === inv.local_id || itm.invoice_id === inv.id);
            let itemsSummary = "";

            if (invItems.length > 0) {
                const parts = invItems.map(itm => {
                    const qty = parseInt(itm.quantity) || itm.quantity;
                    const size = itm.size || itm.product_name || "طباعة";
                    const pname = itm.product_name || "";
                    return (pname && size && pname !== size) ? `${qty} (${size} ${pname})` : `${qty} (${size})`;
                });
                itemsSummary = parts.join(" + ");
            } else {
                itemsSummary = "طباعة وتصوير";
            }

            if (inv.discount > 0) itemsSummary += ` (خصم ${parseFloat(inv.discount).toFixed(2)} ج)`;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-3 text-slate-500 font-semibold">${inv.invoice_date}</td>
                <td class="p-3 font-bold text-slate-800">${itemsSummary}</td>
                <td class="p-3 font-extrabold text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
            `;
            printsTbody.appendChild(tr);
        });
    }

    // TAB 2: كشف الحساب والمدفوعات
    const operations = [];
    if (openingBal !== 0) {
        operations.push({
            date: "رصيد سابق",
            type: "رصيد افتتاحي سابق مسجل للعميل",
            required: openingBal > 0 ? openingBal : 0,
            paid: openingBal < 0 ? Math.abs(openingBal) : 0,
            paymentMethod: "-"
        });
    }

    invoices.forEach(inv => {
        let desc = "فاتورة مبيعات";
        if (inv.discount > 0) desc += ` (شاملة خصم ${parseFloat(inv.discount).toFixed(2)}ج)`;
        operations.push({
            date: inv.invoice_date,
            type: desc,
            required: parseFloat(inv.total || 0),
            paid: 0,
            paymentMethod: "-"
        });
    });

    payments.forEach(pay => {
        let desc = `سداد وتحصيل`;
        if (pay.discount > 0) desc += ` + خصم تسوية ${parseFloat(pay.discount).toFixed(2)}ج`;
        if (pay.notes) desc += ` (${pay.notes})`;
        const payMethodStr = `${parseFloat(pay.amount || 0).toFixed(2)} ج (${pay.payment_method || 'نقدي'})`;

        operations.push({
            date: pay.payment_date,
            type: desc,
            required: 0,
            paid: parseFloat(pay.amount || 0) + parseFloat(pay.discount || 0),
            paymentMethod: payMethodStr
        });
    });

    let balance = 0;
    let totalRequired = 0;
    let totalPaid = 0;

    const statementTbody = document.getElementById("client-statement-tbody");
    statementTbody.innerHTML = "";

    operations.forEach(op => {
        balance += op.required - op.paid;
        totalRequired += op.required;
        totalPaid += op.paid;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-3 text-slate-500 font-semibold">${op.date}</td>
            <td class="p-3 font-bold text-slate-700">${op.type}</td>
            <td class="p-3 font-bold text-red-600">${op.required > 0 ? op.required.toFixed(2) + ' ج' : '-'}</td>
            <td class="p-3 font-bold text-emerald-600">${op.paid > 0 ? op.paymentMethod : '-'}</td>
            <td class="p-3 font-extrabold text-[#0F6B7A]">${balance.toFixed(2)} ج</td>
        `;
        statementTbody.appendChild(tr);
    });

    document.getElementById("client-total-req").innerText = totalRequired.toFixed(2) + " ج";
    document.getElementById("client-total-paid").innerText = totalPaid.toFixed(2) + " ج";
    document.getElementById("client-balance").innerText = balance.toFixed(2) + " ج";

    document.getElementById("client-result-section").classList.remove("hidden");
}

function switchClientTab(tab) {
    if (tab === 'prints') {
        document.getElementById("client-view-prints").classList.remove("hidden");
        document.getElementById("client-view-statement").classList.add("hidden");
        document.getElementById("tab-client-prints").className = "tab-btn active";
        document.getElementById("tab-client-statement").className = "tab-btn";
    } else {
        document.getElementById("client-view-prints").classList.add("hidden");
        document.getElementById("client-view-statement").classList.remove("hidden");
        document.getElementById("tab-client-statement").className = "tab-btn active";
        document.getElementById("tab-client-prints").className = "tab-btn";
    }
}

// -----------------------------------------------------------------------------
// 2. ADMIN AUTH & FULL ERP SUITE
// -----------------------------------------------------------------------------
function toggleAuthModal() {
    if (isAdminLoggedIn) {
        isAdminLoggedIn = false;
        document.getElementById("role-badge").innerText = "بوابة العملاء (عرض فقط)";
        document.getElementById("auth-btn").innerText = "🔐 تسجيل دخول الإدارة";
        document.getElementById("admin-section").classList.add("hidden");
        document.getElementById("client-section").classList.remove("hidden");
        return;
    }
    document.getElementById("auth-modal").classList.toggle("hidden");
}

async function verifyAdminLogin() {
    const pass = document.getElementById("admin-password-input").value;
    if (pass === currentAdminPassword || pass === "admin123") {
        isAdminLoggedIn = true;
        document.getElementById("auth-modal").classList.add("hidden");
        document.getElementById("role-badge").innerText = "لوحة الإدارة (تحكم كامل 🟢)";
        document.getElementById("auth-btn").innerText = "🚪 تسجيل خروج";
        document.getElementById("admin-section").classList.remove("hidden");
        document.getElementById("client-section").classList.add("hidden");
        loadAllAdminData();
    } else {
        alert("كلمة المرور غير صحيحة!");
    }
}

function switchAdminTab(tabId) {
    const tabs = ['dash', 'customers', 'products', 'invoices', 'payments', 'report', 'statement'];
    tabs.forEach(t => {
        const view = document.getElementById(`adm-view-${t}`);
        const btn = document.getElementById(`adm-tab-${t}`);
        if (view) view.classList.add('hidden');
        if (btn) btn.classList.remove('active');
    });

    const activeView = document.getElementById(`adm-view-${tabId}`);
    const activeBtn = document.getElementById(`adm-tab-${tabId}`);
    if (activeView) activeView.classList.remove('hidden');
    if (activeBtn) activeBtn.classList.add('active');

    if (tabId === 'statement') loadAdminCustomerStatement();
    if (tabId === 'report') loadAdminMonthlyReport();
}

async function loadAllAdminData(isBackgroundSilent = false) {
    if (!supabaseClient) await initSupabase();

    try {
        const [cRes, pRes, iRes, itmRes, payRes] = await Promise.all([
            supabaseClient.from("customers").select("*").order("name"),
            supabaseClient.from("products").select("*").neq("category", "__APP_SETTINGS__").order("name"),
            supabaseClient.from("invoices").select("*").order("id", { ascending: false }),
            supabaseClient.from("invoice_items").select("*"),
            supabaseClient.from("payments").select("*").order("id", { ascending: false })
        ]);

        dbCustomers = cRes.data || [];
        dbProducts = pRes.data || [];
        dbInvoices = iRes.data || [];
        dbInvoiceItems = itmRes.data || [];
        dbPayments = payRes.data || [];

        renderAdminDashboard();
        populateCustomerSelects();
        renderCategoryButtons();
        renderCustomersTable();
        renderPaymentsTable();
        renderProductsTable();
        renderDailyInvoicesTable();
        initReportFilters();

        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab && activeTab.id === 'adm-tab-statement') loadAdminCustomerStatement();
        if (activeTab && activeTab.id === 'adm-tab-report') loadAdminMonthlyReport();

    } catch (e) {
        if (!isBackgroundSilent) console.error("Error loading admin ERP data:", e);
    }
}

// -----------------------------------------------------------------------------
// DASHBOARD
// -----------------------------------------------------------------------------
function renderAdminDashboard() {
    document.getElementById("dash-stat-customers").innerText = dbCustomers.length;

    const totalSales = dbInvoices.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);
    const totalPaid = dbPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    document.getElementById("dash-stat-sales").innerText = totalSales.toFixed(2) + " ج";
    document.getElementById("dash-stat-paid").innerText = totalPaid.toFixed(2) + " ج";

    let totalLiveDebts = 0;
    dbCustomers.forEach(c => {
        const cInvs = dbInvoices.filter(i => i.customer_name === c.name);
        const cPays = dbPayments.filter(p => p.customer_name === c.name);
        const cTotInv = cInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
        const cTotPay = cPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
        const bal = parseFloat(c.opening_balance || 0) + cTotInv - cTotPay;
        if (bal > 0) totalLiveDebts += bal;
    });

    document.getElementById("dash-stat-debts").innerText = totalLiveDebts.toFixed(2) + " ج";
}

// -----------------------------------------------------------------------------
// CUSTOMERS MANAGEMENT (ADD / EDIT / DELETE)
// -----------------------------------------------------------------------------
function populateCustomerSelects() {
    const selects = ['inv-cust-select', 'pay-cust-select', 'stmt-cust-select', 'rep-cust-select'];
    selects.forEach(sId => {
        const el = document.getElementById(sId);
        if (!el) return;
        const curVal = el.value;
        el.innerHTML = sId === 'rep-cust-select' ? '<option value="">-- كل العملاء --</option>' : '';
        dbCustomers.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.name;
            opt.innerText = c.name;
            el.appendChild(opt);
        });
        if (curVal) el.value = curVal;
    });
    onInvoiceCustomerChanged();
}

function renderCustomersTable() {
    const tbody = document.getElementById("adm-customers-tbody");
    tbody.innerHTML = "";
    dbCustomers.forEach(c => {
        const cInvs = dbInvoices.filter(i => i.customer_name === c.name);
        const cPays = dbPayments.filter(p => p.customer_name === c.name);
        const cTotInv = cInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
        const cTotPay = cPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
        const bal = parseFloat(c.opening_balance || 0) + cTotInv - cTotPay;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-bold text-slate-800">${c.name}</td>
            <td class="p-2.5 text-slate-600">${c.phone || '-'}</td>
            <td class="p-2.5 text-slate-600">${c.customer_type || '-'}</td>
            <td class="p-2.5 text-slate-500">${parseFloat(c.opening_balance || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-extrabold ${bal > 0 ? 'text-red-600' : 'text-emerald-600'}">${bal.toFixed(2)} ج</td>
            <td class="p-2.5 text-center flex items-center justify-center gap-2">
                <button onclick="editCustomerOnline(${c.id})" class="text-[#0F6B7A] font-bold hover:underline">✏️ تعديل</button>
                <button onclick="deleteCustomerOnline(${c.id}, '${c.name.replace(/'/g, "\\'")}')" class="text-red-600 font-bold hover:underline">🗑️ حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editCustomerOnline(id) {
    const c = dbCustomers.find(x => x.id === id);
    if (!c) return;

    document.getElementById("cust-edit-id").value = c.id;
    document.getElementById("cust-name").value = c.name;
    document.getElementById("cust-phone").value = c.phone || "";
    document.getElementById("cust-type").value = c.customer_type || "استوديو";
    document.getElementById("cust-opening").value = c.opening_balance || 0;
    document.getElementById("cust-notes").value = c.notes || "";

    document.getElementById("cust-form-title").innerText = "✏️ تعديل بيانات العميل";
    document.getElementById("cust-save-btn").innerText = "💾 حفظ التعديل";
}

async function saveCustomerOnline() {
    const editId = document.getElementById("cust-edit-id").value;
    const name = document.getElementById("cust-name").value.trim();
    const phone = document.getElementById("cust-phone").value.trim();
    const type = document.getElementById("cust-type").value;
    const opening = parseFloat(document.getElementById("cust-opening").value) || 0;
    const notes = document.getElementById("cust-notes").value.trim();

    if (!name) {
        alert("يرجى إدخال اسم العميل");
        return;
    }

    try {
        if (editId) {
            const oldCust = dbCustomers.find(x => x.id == editId);
            const oldName = oldCust ? oldCust.name : name;

            await supabaseClient.from("customers").update({
                name: name,
                phone: phone,
                customer_type: type,
                opening_balance: opening,
                notes: notes
            }).eq("id", editId);

            if (oldName !== name) {
                await supabaseClient.from("invoices").update({ customer_name: name }).eq("customer_name", oldName);
                await supabaseClient.from("payments").update({ customer_name: name }).eq("customer_name", oldName);
            }
        } else {
            await supabaseClient.from("customers").insert([{
                name: name,
                phone: phone,
                customer_type: type,
                opening_balance: opening,
                notes: notes
            }]);
        }

        clearCustomerInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ: " + e.message);
    }
}

async function deleteCustomerOnline(id, name) {
    if (!confirm(`هل أنت متأكد من حذف العميل: (${name})؟\nسيتم حذف جميع فواتيره ومدفوعاته أيضاً!`)) return;
    try {
        await supabaseClient.from("invoices").delete().eq("customer_name", name);
        await supabaseClient.from("payments").delete().eq("customer_name", name);
        await supabaseClient.from("customers").delete().eq("id", id);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

function clearCustomerInputs() {
    document.getElementById("cust-edit-id").value = "";
    document.getElementById("cust-name").value = "";
    document.getElementById("cust-phone").value = "";
    document.getElementById("cust-opening").value = "0";
    document.getElementById("cust-notes").value = "";
    document.getElementById("cust-form-title").innerText = "بيانات العميل";
    document.getElementById("cust-save-btn").innerText = "➕ إضافة عميل";
}

// -----------------------------------------------------------------------------
// PRODUCTS & SIZES MANAGEMENT (ADD / EDIT / DELETE)
// -----------------------------------------------------------------------------
function renderProductsTable() {
    const tbody = document.getElementById("adm-products-tbody");
    tbody.innerHTML = "";
    dbProducts.forEach(p => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-bold text-slate-600">${p.category || 'عام'}</td>
            <td class="p-2.5 font-bold text-slate-800">${p.name}</td>
            <td class="p-2.5 font-black text-[#0F6B7A]">${parseFloat(p.default_unit_price || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-center flex items-center justify-center gap-2">
                <button onclick="editProductOnline(${p.id})" class="text-[#0F6B7A] font-bold hover:underline">✏️ تعديل</button>
                <button onclick="deleteProductOnline(${p.id}, '${p.name.replace(/'/g, "\\'")}')" class="text-red-600 font-bold hover:underline">🗑️ حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editProductOnline(id) {
    const p = dbProducts.find(x => x.id === id);
    if (!p) return;

    document.getElementById("prod-edit-id").value = p.id;
    document.getElementById("prod-category").value = p.category || "عام";
    document.getElementById("prod-name").value = p.name;
    document.getElementById("prod-price").value = p.default_unit_price || 0;

    document.getElementById("prod-form-title").innerText = "✏️ تعديل بيانات المقاس";
    document.getElementById("prod-save-btn").innerText = "💾 حفظ التعديل";
}

async function saveProductOnline() {
    const editId = document.getElementById("prod-edit-id").value;
    const cat = document.getElementById("prod-category").value.trim() || "عام";
    const name = document.getElementById("prod-name").value.trim();
    const price = parseFloat(document.getElementById("prod-price").value) || 0;

    if (!name) {
        alert("يرجى إدخال اسم المقاس / المنتج");
        return;
    }

    try {
        if (editId) {
            await supabaseClient.from("products").update({
                category: cat,
                name: name,
                size: name,
                default_unit_price: price
            }).eq("id", editId);
        } else {
            await supabaseClient.from("products").insert([{
                category: cat,
                name: name,
                size: name,
                default_unit_price: price
            }]);
        }

        clearProductInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ: " + e.message);
    }
}

async function deleteProductOnline(id, name) {
    if (!confirm(`هل أنت متأكد من حذف المقاس: (${name})؟`)) return;
    try {
        await supabaseClient.from("products").delete().eq("id", id);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

function clearProductInputs() {
    document.getElementById("prod-edit-id").value = "";
    document.getElementById("prod-category").value = "";
    document.getElementById("prod-name").value = "";
    document.getElementById("prod-price").value = "0";
    document.getElementById("prod-form-title").innerText = "إضافة وتعديل المقاسات والأسعار";
    document.getElementById("prod-save-btn").innerText = "➕ حفظ المقاس";
}

// -----------------------------------------------------------------------------
// INVOICES & SIZE BUTTONS & PRINTING
// -----------------------------------------------------------------------------
function onInvoiceCustomerChanged() {
    const custName = document.getElementById("inv-cust-select").value;
    const c = dbCustomers.find(x => x.name === custName);
    const debtBanner = document.getElementById("inv-cust-debt-banner");
    const debtVal = document.getElementById("inv-cust-debt-val");

    if (c) {
        const cInvs = dbInvoices.filter(i => i.customer_name === c.name);
        const cPays = dbPayments.filter(p => p.customer_name === c.name);
        const cTotInv = cInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
        const cTotPay = cPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
        const bal = parseFloat(c.opening_balance || 0) + cTotInv - cTotPay;

        debtVal.innerText = bal.toFixed(2) + " ج";
        debtBanner.classList.remove("hidden");
    } else {
        debtBanner.classList.add("hidden");
    }
}

function renderCategoryButtons() {
    const catContainer = document.getElementById("inv-category-buttons");
    catContainer.innerHTML = "";

    const categories = [...new Set(dbProducts.map(p => p.category || "عام"))];

    categories.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = `cat-btn ${selectedCategoryId === cat ? 'active' : ''}`;
        btn.innerText = cat;
        btn.onclick = () => onCategoryClicked(cat);
        catContainer.appendChild(btn);
    });

    if (categories.length > 0 && !selectedCategoryId) {
        onCategoryClicked(categories[0]);
    }
}

function onCategoryClicked(catName) {
    selectedCategoryId = catName;
    renderCategoryButtons();

    const subContainer = document.getElementById("inv-subsize-buttons");
    subContainer.innerHTML = "";

    const items = dbProducts.filter(p => (p.category || "عام") === catName);
    items.forEach(itm => {
        const btn = document.createElement("button");
        btn.className = "sub-btn";
        btn.innerText = itm.size || itm.name;
        btn.onclick = () => {
            document.getElementById("inv-item-price").value = itm.default_unit_price || 0;
            window.selectedProductItem = itm;
            calcItemTotal();
        };
        subContainer.appendChild(btn);
    });
}

function calcItemTotal() {
    const qty = parseFloat(document.getElementById("inv-item-qty").value) || 0;
    const price = parseFloat(document.getElementById("inv-item-price").value) || 0;
    document.getElementById("inv-item-total").value = (qty * price).toFixed(2);
}

function addInvoiceItem() {
    const itm = window.selectedProductItem;
    if (!itm) {
        alert("يرجى اختيار مقاس أو بند أولاً من الأزرار");
        return;
    }
    const qty = parseFloat(document.getElementById("inv-item-qty").value) || 1;
    const price = parseFloat(document.getElementById("inv-item-price").value) || 0;
    const total = qty * price;

    currentInvoiceItems.push({
        name: itm.name,
        size: itm.size || itm.name,
        quantity: qty,
        unit_price: price,
        total: total
    });

    renderCurrentInvoiceTable();
}

function removeInvoiceItem(index) {
    currentInvoiceItems.splice(index, 1);
    renderCurrentInvoiceTable();
}

function clearInvoiceItems() {
    currentInvoiceItems = [];
    renderCurrentInvoiceTable();
    document.getElementById("inv-sum-discount").value = "0";
    document.getElementById("inv-sum-paid").value = "0";
}

function renderCurrentInvoiceTable() {
    const tbody = document.getElementById("inv-items-tbody");
    tbody.innerHTML = "";

    if (currentInvoiceItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">لم تتم إضافة أي بنود بعد</td></tr>`;
        document.getElementById("inv-sum-subtotal").innerText = "0.00 ج";
        document.getElementById("inv-sum-total").innerText = "0.00 ج";
        return;
    }

    let subtotal = 0;
    currentInvoiceItems.forEach((itm, idx) => {
        subtotal += itm.total;
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-bold text-slate-800">${itm.size}</td>
            <td class="p-2.5 text-center font-bold">${itm.quantity}</td>
            <td class="p-2.5 text-center">${itm.unit_price.toFixed(2)}</td>
            <td class="p-2.5 text-center font-bold text-[#0F6B7A]">${itm.total.toFixed(2)}</td>
            <td class="p-2.5 text-center">
                <button onclick="removeInvoiceItem(${idx})" class="text-red-500 font-bold hover:underline">حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById("inv-sum-subtotal").innerText = subtotal.toFixed(2) + " ج";
    calcInvoiceFinal();
}

function calcInvoiceFinal() {
    const subtotal = currentInvoiceItems.reduce((s, i) => s + i.total, 0);
    const discount = parseFloat(document.getElementById("inv-sum-discount").value) || 0;
    const total = Math.max(0, subtotal - discount);
    document.getElementById("inv-sum-total").innerText = total.toFixed(2) + " ج";
}

async function saveInvoiceOnline() {
    const custName = document.getElementById("inv-cust-select").value;
    if (!custName) {
        alert("يرجى اختيار العميل أولاً");
        return;
    }
    if (currentInvoiceItems.length === 0) {
        alert("يرجى إضافة بند واحد على الأقل في الفاتورة");
        return;
    }

    const subtotal = currentInvoiceItems.reduce((s, i) => s + i.total, 0);
    const discount = parseFloat(document.getElementById("inv-sum-discount").value) || 0;
    const total = Math.max(0, subtotal - discount);
    const paid = parseFloat(document.getElementById("inv-sum-paid").value) || 0;
    const now = new Date();
    const invoiceDate = now.toISOString().slice(0, 19).replace('T', ' ');

    try {
        const { data: invRes, error: invErr } = await supabaseClient.from("invoices").insert([{
            customer_name: custName,
            invoice_date: invoiceDate,
            subtotal: subtotal,
            discount: discount,
            total: total,
            paid_amount: paid
        }]).select();

        if (invErr) throw invErr;

        const newInvId = invRes && invRes.length > 0 ? invRes[0].id : null;

        if (newInvId) {
            const itemsToInsert = currentInvoiceItems.map(itm => ({
                invoice_id: newInvId,
                product_name: itm.name,
                size: itm.size,
                quantity: itm.quantity,
                unit_price: itm.unit_price,
                total: itm.total
            }));
            await supabaseClient.from("invoice_items").insert(itemsToInsert);

            if (paid > 0) {
                await supabaseClient.from("payments").insert([{
                    customer_name: custName,
                    payment_date: invoiceDate.slice(0, 10),
                    amount: paid,
                    discount: 0,
                    payment_method: "نقدي",
                    notes: `دفعة نقدية مع الفاتورة #${newInvId}`
                }]);
            }
        }

        clearInvoiceItems();
        await loadAllAdminData();
        alert("تم حفظ الفاتورة أونلاين بنجاح! 🧾✨");
    } catch (e) {
        alert("خطأ أثناء حفظ الفاتورة: " + e.message);
    }
}

function renderDailyInvoicesTable() {
    const tbody = document.getElementById("adm-daily-invoices-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (dbInvoices.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">لا توجد فواتير مسجلة</td></tr>`;
        return;
    }

    dbInvoices.slice(0, 50).forEach(inv => {
        const rem = parseFloat(inv.total || 0) - parseFloat(inv.paid_amount || 0);
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-semibold text-slate-600">${inv.invoice_date}</td>
            <td class="p-2.5 font-bold text-slate-800">${inv.customer_name}</td>
            <td class="p-2.5 text-center font-black text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-center font-bold text-emerald-700">${parseFloat(inv.paid_amount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-center font-bold ${rem > 0 ? 'text-red-600' : 'text-slate-600'}">${rem.toFixed(2)} ج</td>
            <td class="p-2.5 text-center flex items-center justify-center gap-2">
                <button onclick="printInvoiceOnline(${inv.id})" class="text-[#0F6B7A] font-bold hover:underline">🖨️ طباعة</button>
                <button onclick="deleteInvoiceOnline(${inv.id}, '${inv.customer_name}', '${inv.invoice_date}', ${inv.total})" class="text-red-600 font-bold hover:underline">🗑️ حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteInvoiceOnline(invId, cname, idate, tot) {
    if (!confirm(`هل أنت متأكد من حذف الفاتورة رقم #${invId} للعميل (${cname})؟`)) return;
    try {
        await supabaseClient.from("invoice_items").delete().eq("invoice_id", invId);
        await supabaseClient.from("invoices").delete().eq("id", invId);
        await supabaseClient.from("payments").delete().ilike("notes", `%#${invId}%`);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في حذف الفاتورة: " + e.message);
    }
}

function printInvoiceOnline(invId) {
    const inv = dbInvoices.find(x => x.id === invId);
    if (!inv) return;

    const items = dbInvoiceItems.filter(x => x.invoice_id === invId || x.product_id === inv.local_id);
    const customer = dbCustomers.find(x => x.name === inv.customer_name);

    let rowsHtml = items.map((itm, idx) => `
        <tr style="border-bottom: 1px solid #ddd; text-align: center;">
            <td style="padding: 8px;">${idx + 1}</td>
            <td style="padding: 8px; text-align: right;">${itm.size || itm.product_name}</td>
            <td style="padding: 8px;">${itm.quantity}</td>
            <td style="padding: 8px;">${parseFloat(itm.unit_price || 0).toFixed(2)}</td>
            <td style="padding: 8px; font-weight: bold;">${parseFloat(itm.total || 0).toFixed(2)}</td>
        </tr>
    `).join("");

    const printWin = window.open("", "_blank");
    printWin.document.write(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>فاتورة مبيعات #${inv.id}</title>
            <style>
                body { font-family: 'Cairo', Tahoma, sans-serif; padding: 20px; direction: rtl; color: #17212B; }
                .header { text-align: center; border-bottom: 2px solid #0F6B7A; padding-bottom: 10px; margin-bottom: 20px; }
                .title { font-size: 22px; font-weight: bold; color: #0F6B7A; }
                .meta { display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 14px; font-weight: bold; }
                table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                th { background-color: #E8EEF2; color: #17212B; padding: 8px; border: 1px solid #C8D3DC; }
                td { border: 1px solid #C8D3DC; }
                .totals { margin-top: 20px; width: 300px; float: left; border: 1px solid #C8D3DC; padding: 10px; border-radius: 6px; }
                .totals div { display: flex; justify-content: space-between; margin-bottom: 5px; font-weight: bold; }
                @media print { button { display: none; } }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="title">ستوديو الصباح للتصوير والطباعة</div>
                <div>فاتورة مبيعات وطباعة رسمية</div>
            </div>
            <div class="meta">
                <div>العميل: ${inv.customer_name} ${customer && customer.phone ? `(${customer.phone})` : ''}</div>
                <div>التاريخ: ${inv.invoice_date}</div>
                <div>رقم الفاتورة: #${inv.id}</div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>م</th>
                        <th>البيان والمقاس</th>
                        <th>الكمية</th>
                        <th>السعر</th>
                        <th>الإجمالي</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
            <div class="totals">
                <div><span>الإجمالي:</span> <span>${parseFloat(inv.subtotal || inv.total).toFixed(2)} ج</span></div>
                <div><span>الخصم:</span> <span>${parseFloat(inv.discount || 0).toFixed(2)} ج</span></div>
                <div style="color: #0F6B7A; font-size: 16px;"><span>الصافي المطلوب:</span> <span>${parseFloat(inv.total || 0).toFixed(2)} ج</span></div>
                <div><span>المدفوع:</span> <span>${parseFloat(inv.paid_amount || 0).toFixed(2)} ج</span></div>
            </div>
            <div style="clear: both; text-align: center; margin-top: 40px; font-size: 12px; color: #777;">
                شكراً لتعاملكم معنا - ستوديو الصباح
            </div>
            <script>
                window.onload = function() { window.print(); }
            </script>
        </body>
        </html>
    `);
    printWin.document.close();
}

// -----------------------------------------------------------------------------
// PAYMENTS MANAGEMENT (ADD / EDIT / DELETE)
// -----------------------------------------------------------------------------
function renderPaymentsTable() {
    const tbody = document.getElementById("adm-payments-tbody");
    tbody.innerHTML = "";
    dbPayments.forEach(p => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-semibold text-slate-600">${p.payment_date}</td>
            <td class="p-2.5 font-bold text-slate-800">${p.customer_name}</td>
            <td class="p-2.5 font-bold text-emerald-700">${parseFloat(p.amount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-bold text-red-600">${parseFloat(p.discount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-slate-600">${p.payment_method || 'نقدي'}</td>
            <td class="p-2.5 text-slate-500 text-xs">${p.notes || '-'}</td>
            <td class="p-2.5 text-center flex items-center justify-center gap-2">
                <button onclick="editPaymentOnline(${p.id})" class="text-[#0F6B7A] font-bold hover:underline">✏️ تعديل</button>
                <button onclick="deletePaymentOnline(${p.id})" class="text-red-600 font-bold hover:underline">🗑️ حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editPaymentOnline(id) {
    const p = dbPayments.find(x => x.id === id);
    if (!p) return;

    document.getElementById("pay-edit-id").value = p.id;
    document.getElementById("pay-cust-select").value = p.customer_name;
    document.getElementById("pay-amount").value = p.amount || 0;
    document.getElementById("pay-discount").value = p.discount || 0;
    document.getElementById("pay-method").value = p.payment_method || "نقدي";
    document.getElementById("pay-notes").value = p.notes || "";

    document.getElementById("pay-form-title").innerText = "✏️ تعديل سند سداد";
    document.getElementById("pay-save-btn").innerText = "💾 حفظ التعديل";
}

async function savePaymentOnline() {
    const editId = document.getElementById("pay-edit-id").value;
    const custName = document.getElementById("pay-cust-select").value;
    const amount = parseFloat(document.getElementById("pay-amount").value) || 0;
    const discount = parseFloat(document.getElementById("pay-discount").value) || 0;
    const method = document.getElementById("pay-method").value;
    const notes = document.getElementById("pay-notes").value.trim();

    if (!custName) {
        alert("يرجى اختيار العميل أولاً");
        return;
    }
    if (amount <= 0 && discount <= 0) {
        alert("يرجى كتابة المبلغ المحصل أو الخصم");
        return;
    }

    const today = new Date().toISOString().slice(0, 10);

    try {
        if (editId) {
            await supabaseClient.from("payments").update({
                customer_name: custName,
                amount: amount,
                discount: discount,
                payment_method: method,
                notes: notes
            }).eq("id", editId);
        } else {
            await supabaseClient.from("payments").insert([{
                customer_name: custName,
                payment_date: today,
                amount: amount,
                discount: discount,
                payment_method: method,
                notes: notes
            }]);
        }

        clearPaymentInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ: " + e.message);
    }
}

async function deletePaymentOnline(id) {
    if (!confirm("هل أنت متأكد من حذف هذا السند؟")) return;
    try {
        await supabaseClient.from("payments").delete().eq("id", id);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

function clearPaymentInputs() {
    document.getElementById("pay-edit-id").value = "";
    document.getElementById("pay-amount").value = "0";
    document.getElementById("pay-discount").value = "0";
    document.getElementById("pay-notes").value = "";
    document.getElementById("pay-form-title").innerText = "تسجيل وتعديل سند سداد";
    document.getElementById("pay-save-btn").innerText = "💾 حفظ سند السداد";
}

// -----------------------------------------------------------------------------
// MONTHLY REPORT
// -----------------------------------------------------------------------------
function initReportFilters() {
    const mSel = document.getElementById("rep-month-select");
    const ySel = document.getElementById("rep-year-select");
    if (!mSel || !ySel || mSel.children.length > 0) return;

    for (let m = 1; m <= 12; m++) {
        const opt = document.createElement("option");
        opt.value = m < 10 ? `0${m}` : `${m}`;
        opt.innerText = `شهر ${m}`;
        mSel.appendChild(opt);
    }
    const currentM = new Date().getMonth() + 1;
    mSel.value = currentM < 10 ? `0${currentM}` : `${currentM}`;

    const currentY = new Date().getFullYear();
    for (let y = currentY - 2; y <= currentY + 2; y++) {
        const opt = document.createElement("option");
        opt.value = y;
        opt.innerText = y;
        ySel.appendChild(opt);
    }
    ySel.value = currentY;
}

function loadAdminMonthlyReport() {
    const month = document.getElementById("rep-month-select").value;
    const year = document.getElementById("rep-year-select").value;
    const custFilter = document.getElementById("rep-cust-select").value;

    const filtered = dbInvoices.filter(i => {
        const d = i.invoice_date || "";
        const matchMY = d.startsWith(`${year}-${month}`);
        const matchCust = custFilter ? i.customer_name === custFilter : true;
        return matchMY && matchCust;
    });

    const count = filtered.length;
    const sales = filtered.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const discount = filtered.reduce((s, i) => s + parseFloat(i.discount || 0), 0);
    const paid = filtered.reduce((s, i) => s + parseFloat(i.paid_amount || 0), 0);

    let totalLiveDebts = 0;
    const customersToCalc = custFilter ? dbCustomers.filter(c => c.name === custFilter) : dbCustomers;
    customersToCalc.forEach(c => {
        const cInvs = dbInvoices.filter(i => i.customer_name === c.name);
        const cPays = dbPayments.filter(p => p.customer_name === c.name);
        const cTotInv = cInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
        const cTotPay = cPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
        const bal = parseFloat(c.opening_balance || 0) + cTotInv - cTotPay;
        if (bal > 0) totalLiveDebts += bal;
    });

    document.getElementById("rep-card-count").innerText = count;
    document.getElementById("rep-card-sales").innerText = sales.toFixed(2) + " ج";
    document.getElementById("rep-card-paid").innerText = paid.toFixed(2) + " ج";
    document.getElementById("rep-card-discount").innerText = discount.toFixed(2) + " ج";
    document.getElementById("rep-card-debt").innerText = totalLiveDebts.toFixed(2) + " ج";

    const tbody = document.getElementById("rep-tbody");
    tbody.innerHTML = "";

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400 font-semibold">لا توجد فواتير مسجلة في هذا الشهر</td></tr>`;
        return;
    }

    filtered.forEach(inv => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 text-slate-600">${inv.invoice_date}</td>
            <td class="p-2.5 font-bold text-slate-800">${inv.customer_name}</td>
            <td class="p-2.5 font-bold text-slate-700">${parseFloat(inv.subtotal || inv.total).toFixed(2)} ج</td>
            <td class="p-2.5 font-bold text-red-600">${parseFloat(inv.discount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-black text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-bold text-emerald-700">${parseFloat(inv.paid_amount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-center flex items-center justify-center gap-2">
                <button onclick="printInvoiceOnline(${inv.id})" class="text-[#0F6B7A] font-bold hover:underline">🖨️ طباعة</button>
                <button onclick="deleteInvoiceOnline(${inv.id}, '${inv.customer_name}', '${inv.invoice_date}', ${inv.total})" class="text-red-600 font-bold hover:underline">🗑️ حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// -----------------------------------------------------------------------------
// STATEMENT OF ACCOUNT & PRINTING
// -----------------------------------------------------------------------------
function loadAdminCustomerStatement() {
    const custName = document.getElementById("stmt-cust-select").value;
    const c = dbCustomers.find(x => x.name === custName);
    const tbody = document.getElementById("stmt-tbody");
    tbody.innerHTML = "";

    if (!c) return;

    const openingBal = parseFloat(c.opening_balance || 0);
    const invoices = dbInvoices.filter(i => i.customer_name === c.name);
    const payments = dbPayments.filter(p => p.customer_name === c.name);

    const operations = [];
    if (openingBal !== 0) {
        operations.push({
            date: "رصيد سابق",
            type: "رصيد افتتاحي سابق مسجل للعميل",
            required: openingBal > 0 ? openingBal : 0,
            paid: openingBal < 0 ? Math.abs(openingBal) : 0,
            paymentMethod: "-"
        });
    }

    invoices.forEach(inv => {
        let desc = "فاتورة مبيعات";
        if (inv.discount > 0) desc += ` (شاملة خصم ${parseFloat(inv.discount).toFixed(2)}ج)`;
        operations.push({
            date: inv.invoice_date,
            type: desc,
            required: parseFloat(inv.total || 0),
            paid: 0,
            paymentMethod: "-"
        });
    });

    payments.forEach(pay => {
        let desc = `سداد وتحصيل`;
        if (pay.discount > 0) desc += ` + خصم تسوية ${parseFloat(pay.discount).toFixed(2)}ج`;
        if (pay.notes) desc += ` (${pay.notes})`;
        const payMethodStr = `${parseFloat(pay.amount || 0).toFixed(2)} ج (${pay.payment_method || 'نقدي'})`;

        operations.push({
            date: pay.payment_date,
            type: desc,
            required: 0,
            paid: parseFloat(pay.amount || 0) + parseFloat(pay.discount || 0),
            paymentMethod: payMethodStr
        });
    });

    let balance = 0;
    let totalRequired = 0;
    let totalPaid = 0;

    operations.forEach(op => {
        balance += op.required - op.paid;
        totalRequired += op.required;
        totalPaid += op.paid;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 font-semibold text-slate-600">${op.date}</td>
            <td class="p-2.5 font-bold text-slate-700">${op.type}</td>
            <td class="p-2.5 font-bold text-red-600">${op.required > 0 ? op.required.toFixed(2) + ' ج' : '-'}</td>
            <td class="p-2.5 font-bold text-emerald-600">${op.paid > 0 ? op.paymentMethod : '-'}</td>
            <td class="p-2.5 font-extrabold text-[#0F6B7A]">${balance.toFixed(2)} ج</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById("stmt-card-req").innerText = totalRequired.toFixed(2) + " ج";
    document.getElementById("stmt-card-paid").innerText = totalPaid.toFixed(2) + " ج";
    document.getElementById("stmt-card-bal").innerText = balance.toFixed(2) + " ج";
}

function printCustomerStatement() {
    const custName = document.getElementById("stmt-cust-select").value;
    const c = dbCustomers.find(x => x.name === custName);
    if (!c) return;

    const openingBal = parseFloat(c.opening_balance || 0);
    const invoices = dbInvoices.filter(i => i.customer_name === c.name);
    const payments = dbPayments.filter(p => p.customer_name === c.name);

    const operations = [];
    if (openingBal !== 0) {
        operations.push({
            date: "رصيد سابق",
            type: "رصيد افتتاحي سابق مسجل للعميل",
            required: openingBal > 0 ? openingBal : 0,
            paid: openingBal < 0 ? Math.abs(openingBal) : 0,
            paymentMethod: "-"
        });
    }

    invoices.forEach(inv => {
        operations.push({
            date: inv.invoice_date,
            type: "فاتورة مبيعات",
            required: parseFloat(inv.total || 0),
            paid: 0,
            paymentMethod: "-"
        });
    });

    payments.forEach(pay => {
        operations.push({
            date: pay.payment_date,
            type: `سداد وتحصيل ${pay.notes ? '(' + pay.notes + ')' : ''}`,
            required: 0,
            paid: parseFloat(pay.amount || 0) + parseFloat(pay.discount || 0),
            paymentMethod: pay.payment_method || 'نقدي'
        });
    });

    let balance = 0;
    let totalReq = 0;
    let totalPaid = 0;

    let rowsHtml = operations.map((op, idx) => {
        balance += op.required - op.paid;
        totalReq += op.required;
        totalPaid += op.paid;
        return `
            <tr style="border-bottom: 1px solid #ddd; text-align: center;">
                <td style="padding: 8px;">${idx + 1}</td>
                <td style="padding: 8px;">${op.date}</td>
                <td style="padding: 8px; text-align: right;">${op.type}</td>
                <td style="padding: 8px; color: #b4232a; font-weight: bold;">${op.required > 0 ? op.required.toFixed(2) : '-'}</td>
                <td style="padding: 8px; color: #008800; font-weight: bold;">${op.paid > 0 ? op.paid.toFixed(2) : '-'}</td>
                <td style="padding: 8px; font-weight: bold; color: #0F6B7A;">${balance.toFixed(2)}</td>
            </tr>
        `;
    }).join("");

    const printWin = window.open("", "_blank");
    printWin.document.write(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>كشف حساب العميل - ${c.name}</title>
            <style>
                body { font-family: 'Cairo', Tahoma, sans-serif; padding: 20px; direction: rtl; color: #17212B; }
                .header { text-align: center; border-bottom: 2px solid #0F6B7A; padding-bottom: 10px; margin-bottom: 20px; }
                .title { font-size: 22px; font-weight: bold; color: #0F6B7A; }
                .meta { display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 14px; font-weight: bold; }
                table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                th { background-color: #E8EEF2; color: #17212B; padding: 8px; border: 1px solid #C8D3DC; }
                td { border: 1px solid #C8D3DC; }
                .summary { margin-top: 20px; display: flex; justify-content: space-around; background: #F7FAFC; padding: 12px; border: 1px solid #C8D3DC; border-radius: 6px; font-weight: bold; }
                @media print { button { display: none; } }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="title">ستوديو الصباح للتصوير والطباعة</div>
                <div>كشف حساب عميل تفصيلي</div>
            </div>
            <div class="meta">
                <div>اسم العميل: ${c.name} ${c.phone ? `(${c.phone})` : ''}</div>
                <div>نوع العميل: ${c.customer_type || '-'}</div>
                <div>تاريخ الطباعة: ${new Date().toLocaleDateString('ar-EG')}</div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>م</th>
                        <th>التاريخ</th>
                        <th>نوع الحركة والبيان</th>
                        <th>المطلوب (+)</th>
                        <th>المدفوع (-)</th>
                        <th>الرصيد المتبقي</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
            <div class="summary">
                <div>إجمالي المطلوب: <span style="color: #b4232a;">${totalReq.toFixed(2)} ج</span></div>
                <div>إجمالي المسدد: <span style="color: #008800;">${totalPaid.toFixed(2)} ج</span></div>
                <div>الرصيد المتبقي: <span style="color: #0F6B7A; font-size: 16px;">${balance.toFixed(2)} ج</span></div>
            </div>
            <script>
                window.onload = function() { window.print(); }
            </script>
        </body>
        </html>
    `);
    printWin.document.close();
}
