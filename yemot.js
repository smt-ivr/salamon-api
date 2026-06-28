// yemot.js

// פונקציה לבדיקה האם המספר קיים ברשימה (משתמש יחיד)
export async function checkPhoneStatus(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getlistEnteres&TzintukimList=members`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.responseStatus !== 'OK') return { exists: false };

    const userInList = data.enteres.find(u => u.phone === phone);
    if (userInList) {
        return { exists: true, active: userInList.active };
    }
    return { exists: false };
}

// פונקציה לשליפת כל המשתמשים מימות המשיח (לפאנל ניהול)
export async function getAllYemotUsers(token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getlistEnteres&TzintukimList=members`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.responseStatus === 'OK' && data.enteres) {
            return data.enteres;
        }
    } catch (e) {
        console.error("שגיאה בשליפת רשימת המשתמשים מימות:", e);
    }
    return [];
}

// פונקציה לשליפת השם מקובץ ה-INI (משתמש יחיד)
export async function getNameFromIni(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=ivr2:/EnterID/EnterIDValName.ini`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.responseStatus !== 'OK' || !data.contents) return null;

    const lines = data.contents.split('\n');
    for (const line of lines) {
        const [linePhone, lineName] = line.split('=');
        if (linePhone === phone && lineName) {
            return lineName.trim();
        }
    }
    return null;
}

// פונקציה לשליפת כל השמות מקובץ ה-INI למפת מילון (לפאנל ניהול)
export async function getAllNamesFromIni(token) {
    const url = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=ivr2:/EnterID/EnterIDValName.ini`;
    const namesMap = {};
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.responseStatus === 'OK' && data.contents) {
            const lines = data.contents.split('\n');
            for (const line of lines) {
                const [phone, name] = line.split('=');
                if (phone && name) {
                    namesMap[phone.trim()] = name.trim();
                }
            }
        }
    } catch (e) {
        console.error("שגיאה בשליפת שמות ה-INI:", e);
    }
    return namesMap;
}
