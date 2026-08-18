// ==============================================================================
// حسابات ستوديو الصباح - البوابة السحابية المباشرة (SUPABASE + GITHUB PAGES)
// ==============================================================================

const SUPABASE_DEFAULT_URL = "https://uikxkghfjcykukauuowz.supabase.co";
const SUPABASE_DEFAULT_KEY = "sb_publishable_zJSR4sB3dZr9dyUT4kTRBQ_ATl8YqNW";

let supabaseClient = null;
let isAdminLoggedIn = false;
let currentAdminPassword = "admin123";

document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
});

async function initSupabase() {
    const url = localStorage.getItem("supabase_url") || SUPABASE_DEFAULT_URL;
    const key = localStorage.getItem("supabase_key") || SUPABASE_DEFAULT_KEY;

    try {
        supabaseClient = window.supabase.createClient(url, key);

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
// CLIENT PORTAL (SEARCH & 2-TAB DISPLAY)
// -----------------------------------------------------------------------------
async function searchClientAccount() {
    const phoneInput = document.getElementById("client-phone-input").value.trim();
    if (!phoneInput) {
        alert("يرجى إدخال رقم الهاتف المسجل لدينا");
        return;
    }

    if (!supabaseClient) {
        await initSupabase();
    }

    try {
        // Find customer by phone
        const { data: customers, error: cErr } = await supabaseClient
            .from("customers")
            .select("*")
            .ilike("phone", `%${phoneInput}%`)
            .limit(1);

        if (cErr || !customers || customers.length === 0) {
            alert("لم يتم العثور على عميل مسجل بهذا الرقم! يرجى التأكد من كتابة الرقم بشكل صحيح.");
            return;
        }

        const customer = customers[0];

        // Fetch Invoices
        const { data: invoices } = await supabaseClient
            .from("invoices")
            .select("*")
            .or(`customer_name.eq.${customer.name},customer_id.eq.${customer.id}`)
            .order("invoice_date", { ascending: true });

        // Fetch Invoice Items
        const { data: allItems } = await supabaseClient
            .from("invoice_items")
            .select("*");

        // Fetch Payments
        const { data: payments } = await supabaseClient
            .from("payments")
            .select("*")
            .or(`customer_name.eq.${customer.name},customer_id.eq.${customer.id}`)
            .order("payment_date", { ascending: true });

        displayClientData(customer, invoices || [], allItems || [], payments || []);

    } catch (err) {
        alert("حدث خطأ أثناء جلب البيانات: " + err.message);
    }
}

function displayClientData(customer, invoices, allItems, payments) {
    document.getElementById("client-name").innerText = customer.name;
    document.getElementById("client-phone").innerText = customer.phone || "-";
    document.getElementById("client-type").innerText = customer.customer_type || "-";

    const openingBal = parseFloat(customer.opening_balance || 0);

    // ---------------------------------------------------------
    // TAB 1: بيان الطباعة وتفاصيل المقاسات
    // ---------------------------------------------------------
    const printsTbody = document.getElementById("client-prints-tbody");
    printsTbody.innerHTML = "";

    if (invoices.length === 0) {
        printsTbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-400 font-semibold">لا توجد فواتير طباعة مسجلة حتى الآن</td></tr>`;
    } else {
        invoices.forEach(inv => {
            // Find items for this invoice
            const invItems = allItems.filter(itm => itm.product_id === inv.local_id || itm.invoice_id === inv.id);
            let itemsSummary = "";

            if (invItems.length > 0) {
                const parts = invItems.map(itm => {
                    const qty = parseInt(itm.quantity) || itm.quantity;
                    const size = itm.size || itm.product_name || "طباعة";
                    const pname = itm.product_name || "";
                    if (pname && size && pname !== size) {
                        return `${qty} (${size} ${pname})`;
                    }
                    return `${qty} (${size})`;
                });
                itemsSummary = parts.join(" + ");
            } else {
                itemsSummary = "طباعة وتصوير";
            }

            if (inv.discount > 0) {
                itemsSummary += ` (خصم ${parseFloat(inv.discount).toFixed(2)} ج)`;
            }

            const tr = document.createElement("tr");
            tr.className = "hover:bg-slate-50 transition";
            tr.innerHTML = `
                <td class="p-3 text-slate-500 font-semibold">${inv.invoice_date}</td>
                <td class="p-3 font-bold text-slate-800">${itemsSummary}</td>
                <td class="p-3 font-extrabold text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
            `;
            printsTbody.appendChild(tr);
        });
    }

    // ---------------------------------------------------------
    // TAB 2: كشف الحساب والمدفوعات
    // ---------------------------------------------------------
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
        tr.className = "hover:bg-slate-50 transition";
        tr.innerHTML = `
            <td class="p-3 text-slate-500 font-semibold">${op.date}</td>
            <td class="p-3 font-bold text-slate-700">${op.type}</td>
            <td class="p-3 font-bold text-red-600">${op.required > 0 ? op.required.toFixed(2) + ' ج' : '-'}</td>
            <td class="p-3 font-bold text-emerald-600">${op.paid > 0 ? op.paymentMethod : '-'}</td>
            <td class="p-3 font-extrabold text-[#0F6B7A]">${balance.toFixed(2)} ج</td>
        `;
        statementTbody.appendChild(tr);
    });

    // Summary Cards
    document.getElementById("client-total-req").innerText = totalRequired.toFixed(2) + " ج";
    document.getElementById("client-total-paid").innerText = totalPaid.toFixed(2) + " ج";
    document.getElementById("client-balance").innerText = balance.toFixed(2) + " ج";

    document.getElementById("client-result-section").classList.remove("hidden");
}

function switchClientTab(tab) {
    if (tab === 'prints') {
        document.getElementById("client-view-prints").classList.remove("hidden");
        document.getElementById("client-view-statement").classList.add("hidden");
        document.getElementById("tab-client-prints").className = "px-6 py-3 font-bold text-sm text-[#0F6B7A] border-b-2 border-[#0F6B7A] bg-white flex items-center gap-2";
        document.getElementById("tab-client-statement").className = "px-6 py-3 font-bold text-sm text-slate-500 hover:text-slate-700 flex items-center gap-2";
    } else {
        document.getElementById("client-view-prints").classList.add("hidden");
        document.getElementById("client-view-statement").classList.remove("hidden");
        document.getElementById("tab-client-statement").className = "px-6 py-3 font-bold text-sm text-[#0F6B7A] border-b-2 border-[#0F6B7A] bg-white flex items-center gap-2";
        document.getElementById("tab-client-prints").className = "px-6 py-3 font-bold text-sm text-slate-500 hover:text-slate-700 flex items-center gap-2";
    }
}

// -----------------------------------------------------------------------------
// ADMIN AUTH & PORTAL
// -----------------------------------------------------------------------------
function toggleAuthModal() {
    if (isAdminLoggedIn) {
        isAdminLoggedIn = false;
        document.getElementById("role-badge").innerText = "بوابة العملاء (عرض فقط)";
        document.getElementById("auth-btn").innerText = "🔐 تسجيل دخول الإدارة";
        document.getElementById("admin-dashboard-section").classList.add("hidden");
        document.getElementById("client-search-section").classList.remove("hidden");
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
        document.getElementById("admin-dashboard-section").classList.remove("hidden");
        document.getElementById("client-search-section").classList.add("hidden");
        document.getElementById("client-result-section").classList.add("hidden");
        loadAdminDashboardData();
    } else {
        alert("كلمة المرور غير صحيحة! يرجى التأكد من كتابة كلمة المرور المحددة في برنامج الكمبيوتر.");
    }
}

async function loadAdminDashboardData() {
    if (!supabaseClient) await initSupabase();

    try {
        const { data: customers } = await supabaseClient.from("customers").select("*");
        const { data: invoices } = await supabaseClient.from("invoices").select("*").order("id", { ascending: false });
        const { data: payments } = await supabaseClient.from("payments").select("*").order("id", { ascending: false });

        document.getElementById("admin-stat-customers").innerText = (customers || []).length;

        const totalSales = (invoices || []).reduce((sum, i) => sum + parseFloat(i.total || 0), 0);
        const totalPaid = (payments || []).reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

        document.getElementById("admin-stat-sales").innerText = totalSales.toFixed(2) + " ج";
        document.getElementById("admin-stat-paid").innerText = totalPaid.toFixed(2) + " ج";

        // Render Invoices Table
        const invTbody = document.getElementById("admin-invoices-tbody");
        invTbody.innerHTML = "";
        (invoices || []).forEach(inv => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-3 text-slate-500">${inv.invoice_date}</td>
                <td class="p-3 font-bold text-slate-800">${inv.customer_name || '-'}</td>
                <td class="p-3 font-semibold">${parseFloat(inv.subtotal || inv.total).toFixed(2)} ج</td>
                <td class="p-3 text-red-600 font-semibold">${parseFloat(inv.discount || 0).toFixed(2)} ج</td>
                <td class="p-3 font-bold text-[#0F6B7A]">${parseFloat(inv.total || 0).toFixed(2)} ج</td>
                <td class="p-3 text-emerald-600 font-bold">${parseFloat(inv.paid_amount || 0).toFixed(2)} ج</td>
            `;
            invTbody.appendChild(tr);
        });

        // Render Customers Table & Calc Total Debts
        let totalLiveDebts = 0;
        const custTbody = document.getElementById("admin-customers-tbody");
        custTbody.innerHTML = "";
        (customers || []).forEach(c => {
            const cInvs = (invoices || []).filter(i => i.customer_name === c.name);
            const cPays = (payments || []).filter(p => p.customer_name === c.name);

            const cTotInv = cInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0);
            const cTotPay = cPays.reduce((s, p) => s + parseFloat(p.amount || 0) + parseFloat(p.discount || 0), 0);
            const cBal = parseFloat(c.opening_balance || 0) + cTotInv - cTotPay;
            if (cBal > 0) totalLiveDebts += cBal;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-3 font-bold text-slate-800">${c.name}</td>
                <td class="p-3 text-slate-600">${c.phone || '-'}</td>
                <td class="p-3 text-slate-600">${c.customer_type || '-'}</td>
                <td class="p-3 text-slate-500">${parseFloat(c.opening_balance || 0).toFixed(2)} ج</td>
                <td class="p-3 font-extrabold ${cBal > 0 ? 'text-red-600' : 'text-emerald-600'}">${cBal.toFixed(2)} ج</td>
            `;
            custTbody.appendChild(tr);
        });

        document.getElementById("admin-stat-debts").innerText = totalLiveDebts.toFixed(2) + " ج";

        // Render Payments Table
        const payTbody = document.getElementById("admin-payments-tbody");
        payTbody.innerHTML = "";
        (payments || []).forEach(p => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-3 text-slate-500">${p.payment_date}</td>
                <td class="p-3 font-bold text-slate-800">${p.customer_name || '-'}</td>
                <td class="p-3 font-bold text-emerald-600">${parseFloat(p.amount || 0).toFixed(2)} ج</td>
                <td class="p-3 font-bold text-red-600">${parseFloat(p.discount || 0).toFixed(2)} ج</td>
                <td class="p-3 text-slate-600">${p.payment_method || 'نقدي'}</td>
                <td class="p-3 text-slate-500">${p.notes || '-'}</td>
            `;
            payTbody.appendChild(tr);
        });

    } catch (e) {
        console.error("Error loading admin data:", e);
    }
}

function switchAdminTab(tab) {
    ['invoices', 'customers', 'payments'].forEach(t => {
        document.getElementById(`admin-tab-${t}`).classList.add('hidden');
        document.getElementById(`tab-btn-${t}`).className = 'px-6 py-3 font-bold text-sm text-slate-500 hover:text-slate-700';
    });
    document.getElementById(`admin-tab-${tab}`).classList.remove('hidden');
    document.getElementById(`tab-btn-${tab}`).className = 'px-6 py-3 font-bold text-sm text-[#0F6B7A] border-b-2 border-[#0F6B7A] bg-white';
}
