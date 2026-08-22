// ==============================================================================
// حسابات ستوديو الصباح - نظام الويب المتكامل مع التحديث اللحظي الفوري (Realtime)
// ==============================================================================

const SUPABASE_DEFAULT_URL = "https://uikxkghfjcykukauuowz.supabase.co";
const SUPABASE_DEFAULT_KEY = "sb_publishable_zJSR4sB3dZr9dyUT4kTRBQ_ATl8YqNW";

let supabaseClient = null;
let isAdminLoggedIn = false;
let currentAdminPassword = "admin123";
let realtimeChannel = null;

// Cache state
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
    // 3-second auto-poll fallback to ensure 100% instant sync everywhere
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

        // Enable Supabase Realtime Subscription (WebSocket)
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
            console.log("Realtime subscription fallback to polling:", rtErr);
        }

        // Fetch custom admin password if configured
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
// CUSTOMERS MANAGEMENT
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
            <td class="p-2.5 text-center">
                <button onclick="deleteCustomerOnline(${c.id})" class="text-red-600 font-bold hover:underline">حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function saveCustomerOnline() {
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
        await supabaseClient.from("customers").insert([{
            name: name,
            phone: phone,
            customer_type: type,
            opening_balance: opening,
            notes: notes
        }]);

        clearCustomerInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ: " + e.message);
    }
}

async function deleteCustomerOnline(id) {
    if (!confirm("هل أنت متأكد من رغبتك في حذف هذا العميل؟")) return;
    try {
        await supabaseClient.from("customers").delete().eq("id", id);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

function clearCustomerInputs() {
    document.getElementById("cust-name").value = "";
    document.getElementById("cust-phone").value = "";
    document.getElementById("cust-opening").value = "0";
    document.getElementById("cust-notes").value = "";
}

// -----------------------------------------------------------------------------
// PRODUCTS & SIZES MANAGEMENT
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
            <td class="p-2.5 text-center">
                <button onclick="deleteProductOnline(${p.id})" class="text-red-600 font-bold hover:underline">حذف</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function saveProductOnline() {
    const cat = document.getElementById("prod-category").value.trim() || "عام";
    const name = document.getElementById("prod-name").value.trim();
    const price = parseFloat(document.getElementById("prod-price").value) || 0;

    if (!name) {
        alert("يرجى إدخال اسم المقاس / المنتج");
        return;
    }

    try {
        await supabaseClient.from("products").insert([{
            category: cat,
            name: name,
            size: name,
            default_unit_price: price
        }]);

        clearProductInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ: " + e.message);
    }
}

async function deleteProductOnline(id) {
    if (!confirm("هل أنت متأكد من حذف هذا المقاس؟")) return;
    try {
        await supabaseClient.from("products").delete().eq("id", id);
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

function clearProductInputs() {
    document.getElementById("prod-name").value = "";
    document.getElementById("prod-price").value = "0";
}

// -----------------------------------------------------------------------------
// INVOICES & SIZE BUTTONS
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

function renderCurrentInvoiceTable() {
    const tbody = document.getElementById("inv-items-tbody");
    tbody.innerHTML = "";

    if (currentInvoiceItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">لم تتم إضافة أي بنود بعد</td></tr>`;
    } else {
        currentInvoiceItems.forEach((itm, idx) => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-2.5 font-bold text-slate-800">${itm.size || itm.name}</td>
                <td class="p-2.5 text-center font-bold">${itm.quantity}</td>
                <td class="p-2.5 text-center font-bold">${itm.unit_price.toFixed(2)}</td>
                <td class="p-2.5 text-center font-black text-[#0F6B7A]">${itm.total.toFixed(2)}</td>
                <td class="p-2.5 text-center">
                    <button onclick="removeInvoiceItem(${idx})" class="text-red-600 font-bold hover:underline">حذف</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    calcInvoiceFinal();
}

function removeInvoiceItem(idx) {
    currentInvoiceItems.splice(idx, 1);
    renderCurrentInvoiceTable();
}

function clearInvoiceItems() {
    currentInvoiceItems = [];
    renderCurrentInvoiceTable();
}

function calcInvoiceFinal() {
    const subtotal = currentInvoiceItems.reduce((s, itm) => s + itm.total, 0);
    const discount = parseFloat(document.getElementById("inv-sum-discount").value) || 0;
    const total = Math.max(0, subtotal - discount);

    document.getElementById("inv-sum-subtotal").innerText = subtotal.toFixed(2) + " ج";
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

    const subtotal = currentInvoiceItems.reduce((s, itm) => s + itm.total, 0);
    const discount = parseFloat(document.getElementById("inv-sum-discount").value) || 0;
    const total = Math.max(0, subtotal - discount);
    const paid = parseFloat(document.getElementById("inv-sum-paid").value) || 0;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10) + " " + now.toTimeString().slice(0, 5);

    try {
        const { data: invData, error: iErr } = await supabaseClient.from("invoices").insert([{
            customer_name: custName,
            invoice_date: dateStr,
            subtotal: subtotal,
            discount: discount,
            total: total,
            paid_amount: paid
        }]).select();

        if (iErr) throw iErr;
        const invId = invData[0].id;

        const itemsPayload = currentInvoiceItems.map(itm => ({
            invoice_id: invId,
            product_name: itm.name,
            size: itm.size,
            quantity: itm.quantity,
            unit_price: itm.unit_price,
            total: itm.total
        }));
        await supabaseClient.from("invoice_items").insert(itemsPayload);

        if (paid > 0) {
            await supabaseClient.from("payments").insert([{
                customer_name: custName,
                invoice_id: invId,
                payment_date: dateStr.slice(0, 10),
                amount: paid,
                discount: 0,
                payment_method: "نقدي",
                notes: `دفعة فورية مع الفاتورة #${invId}`
            }]);
        }

        clearInvoiceItems();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ أثناء حفظ الفاتورة: " + e.message);
    }
}

// -----------------------------------------------------------------------------
// PAYMENTS MANAGEMENT
// -----------------------------------------------------------------------------
function renderPaymentsTable() {
    const tbody = document.getElementById("adm-payments-tbody");
    tbody.innerHTML = "";
    dbPayments.forEach(p => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 text-slate-500">${p.payment_date}</td>
            <td class="p-2.5 font-bold text-slate-800">${p.customer_name || '-'}</td>
            <td class="p-2.5 font-bold text-emerald-600">${parseFloat(p.amount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-bold text-red-600">${parseFloat(p.discount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 text-slate-600">${p.payment_method || 'نقدي'}</td>
            <td class="p-2.5 text-slate-500">${p.notes || '-'}</td><td class="p-2.5 text-center"><button onclick="deletePaymentOnline(${p.id})" class="text-red-600 font-bold hover:underline">حذف</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function savePaymentOnline() {
    const custName = document.getElementById("pay-cust-select").value;
    const amount = parseFloat(document.getElementById("pay-amount").value) || 0;
    const discount = parseFloat(document.getElementById("pay-discount").value) || 0;
    const method = document.getElementById("pay-method").value;
    const notes = document.getElementById("pay-notes").value.trim();

    if (amount <= 0 && discount <= 0) {
        alert("يرجى إدخال مبلغ التحصيل أو الخصم");
        return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    try {
        await supabaseClient.from("payments").insert([{
            customer_name: custName,
            payment_date: todayStr,
            amount: amount,
            discount: discount,
            payment_method: method,
            notes: notes
        }]);

        clearPaymentInputs();
        await loadAllAdminData();
    } catch (e) {
        alert("خطأ أثناء الحفظ: " + e.message);
    }
}

function clearPaymentInputs() {
    document.getElementById("pay-amount").value = "0";
    document.getElementById("pay-discount").value = "0";
    document.getElementById("pay-notes").value = "";
}

// -----------------------------------------------------------------------------
// MONTHLY REPORT
// -----------------------------------------------------------------------------
function initReportFilters() {
    const mSelect = document.getElementById("rep-month-select");
    const ySelect = document.getElementById("rep-year-select");
    if (!mSelect || !ySelect) return;

    const curMVal = mSelect.value;
    const curYVal = ySelect.value;

    mSelect.innerHTML = "";
    ySelect.innerHTML = "";

    for (let m = 1; m <= 12; m++) {
        const opt = document.createElement("option");
        opt.value = m.toString().padStart(2, '0');
        opt.innerText = `شهر ${m}`;
        if (!curMVal && m === (new Date().getMonth() + 1)) opt.selected = true;
        if (curMVal && opt.value === curMVal) opt.selected = true;
        mSelect.appendChild(opt);
    }

    const curY = new Date().getFullYear();
    for (let y = curY - 2; y <= curY + 2; y++) {
        const opt = document.createElement("option");
        opt.value = y.toString();
        opt.innerText = y.toString();
        if (!curYVal && y === curY) opt.selected = true;
        if (curYVal && opt.value === curYVal) opt.selected = true;
        ySelect.appendChild(opt);
    }
}

function loadAdminMonthlyReport() {
    const m = document.getElementById("rep-month-select").value;
    const y = document.getElementById("rep-year-select").value;
    const cust = document.getElementById("rep-cust-select").value;

    const prefix = `${y}-${m}`;
    let filteredInvs = dbInvoices.filter(i => (i.invoice_date || '').startsWith(prefix));
    let filteredPays = dbPayments.filter(p => (p.payment_date || '').startsWith(prefix));

    if (cust) {
        filteredInvs = filteredInvs.filter(i => i.customer_name === cust);
        filteredPays = filteredPays.filter(p => p.customer_name === cust);
    }

    const count = filteredInvs.length;
    const sales = filteredInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const paid = filteredPays.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const discount = filteredInvs.reduce((s, i) => s + parseFloat(i.discount || 0), 0);

    let debts = 0;
    if (cust) {
        const c = dbCustomers.find(x => x.name === cust);
        if (c) {
            const allInvs = dbInvoices.filter(i => i.customer_name === c.name);
            const allPays = dbPayments.filter(p => p.customer_name === c.name);
            debts = parseFloat(c.opening_balance || 0) + allInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0) - allPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
        }
    } else {
        dbCustomers.forEach(c => {
            const allInvs = dbInvoices.filter(i => i.customer_name === c.name);
            const allPays = dbPayments.filter(p => p.customer_name === c.name);
            const bal = parseFloat(c.opening_balance || 0) + allInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0) - allPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
            if (bal > 0) debts += bal;
        });
    }

    document.getElementById("rep-card-count").innerText = count;
    document.getElementById("rep-card-sales").innerText = sales.toFixed(2) + " ج";
    document.getElementById("rep-card-paid").innerText = paid.toFixed(2) + " ج";
    document.getElementById("rep-card-discount").innerText = discount.toFixed(2) + " ج";
    document.getElementById("rep-card-debt").innerText = debts.toFixed(2) + " ج";

    const tbody = document.getElementById("rep-tbody");
    tbody.innerHTML = "";
    filteredInvs.forEach(inv => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 text-slate-500">${inv.invoice_date}</td>
            <td class="p-2.5 font-bold text-slate-800">${inv.customer_name || '-'}</td>
            <td class="p-2.5 font-bold">${parseFloat(inv.subtotal || inv.total).toFixed(2)} ج</td>
            <td class="p-2.5 text-red-600 font-bold">${parseFloat(inv.discount || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-black text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
            <td class="p-2.5 font-bold text-emerald-600">${parseFloat(inv.paid_amount || 0).toFixed(2)} ج</td><td class="p-2.5 text-center"><button onclick="deleteInvoiceOnline(${inv.id})" class="text-red-600 font-bold hover:underline">حذف</button></td>
        `;
        tbody.appendChild(tr);
    });
}

// -----------------------------------------------------------------------------
// STATEMENT OF ACCOUNT
// -----------------------------------------------------------------------------
function loadAdminCustomerStatement() {
    const custName = document.getElementById("stmt-cust-select").value;
    const c = dbCustomers.find(x => x.name === custName);
    if (!c) return;

    const invoices = dbInvoices.filter(i => i.customer_name === c.name).sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
    const payments = dbPayments.filter(p => p.customer_name === c.name).sort((a, b) => a.payment_date.localeCompare(b.payment_date));
    const openingBal = parseFloat(c.opening_balance || 0);

    const operations = [];
    if (openingBal !== 0) {
        operations.push({
            date: "رصيد سابق",
            type: "رصيد افتتاحي سابق مسجل للعميل",
            required: openingBal > 0 ? openingBal : 0,
            paid: openingBal < 0 ? Math.abs(openingBal) : 0
        });
    }

    invoices.forEach(inv => {
        let desc = "فاتورة مبيعات";
        if (inv.discount > 0) desc += ` (شاملة خصم ${parseFloat(inv.discount).toFixed(2)}ج)`;
        operations.push({
            date: inv.invoice_date,
            type: desc,
            required: parseFloat(inv.total || 0),
            paid: 0
        });
    });

    payments.forEach(pay => {
        let desc = `سداد وتحصيل (${pay.payment_method || 'نقدي'})`;
        if (pay.discount > 0) desc += ` + خصم تسوية ${parseFloat(pay.discount).toFixed(2)}ج`;
        if (pay.notes) desc += ` - ${pay.notes}`;
        operations.push({
            date: pay.payment_date,
            type: desc,
            required: 0,
            paid: parseFloat(pay.amount || 0) + parseFloat(pay.discount || 0)
        });
    });

    let balance = 0;
    let totalReq = 0;
    let totalPaid = 0;
    const tbody = document.getElementById("stmt-tbody");
    tbody.innerHTML = "";

    operations.forEach(op => {
        balance += op.required - op.paid;
        totalReq += op.required;
        totalPaid += op.paid;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="p-2.5 text-slate-500 font-semibold">${op.date}</td>
            <td class="p-2.5 font-bold text-slate-700">${op.type}</td>
            <td class="p-2.5 font-bold text-red-600">${op.required > 0 ? op.required.toFixed(2) + ' ج' : '-'}</td>
            <td class="p-2.5 font-bold text-emerald-600">${op.paid > 0 ? op.paid.toFixed(2) + ' ج' : '-'}</td>
            <td class="p-2.5 font-black text-[#0F6B7A]">${balance.toFixed(2)} ج</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById("stmt-req-val").innerText = totalReq.toFixed(2) + " ج";
    document.getElementById("stmt-paid-val").innerText = totalPaid.toFixed(2) + " ج";
    document.getElementById("stmt-bal-val").innerText = balance.toFixed(2) + " ج";
}


async function deletePaymentOnline(id) {
    if (!confirm("هل أنت متأكد من رغبتك في حذف هذا السند؟")) return;
    try {
        await supabaseClient.from("payments").delete().eq("id", id);
        await loadAllAdminData();
        alert("تم حذف السند بنجاح!");
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}

async function deleteInvoiceOnline(id) {
    if (!confirm(`هل أنت متأكد من حذف الفاتورة رقم #${id} وجميع بنودها؟`)) return;
    try {
        await supabaseClient.from("invoice_items").delete().eq("invoice_id", id);
        await supabaseClient.from("invoices").delete().eq("id", id);
        await loadAllAdminData();
        alert("تم حذف الفاتورة بنجاح!");
    } catch (e) {
        alert("خطأ في الحذف: " + e.message);
    }
}
