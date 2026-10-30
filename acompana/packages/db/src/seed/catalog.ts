/** Catálogos del seed. Universidades y personas son FICTICIAS; las regiones son regiones reales del Perú. */

export const REGIONS = [
  ['LIM', 'Lima'],
  ['ARE', 'Arequipa'],
  ['LAL', 'La Libertad'],
  ['CUS', 'Cusco'],
  ['PUN', 'Puno'],
  ['LOR', 'Loreto'],
  ['AYA', 'Ayacucho'],
  ['HVC', 'Huancavelica'],
  ['CAJ', 'Cajamarca'],
  ['UCA', 'Ucayali'],
  ['APU', 'Apurímac'],
  ['PIU', 'Piura'],
] as const;

export const UNIVERSITIES = [
  { id: 'U1', name: 'Universidad Nacional del Rímac (ficticia)', city: 'Lima', regionId: 'LIM' },
  { id: 'U2', name: 'Universidad del Misti (ficticia)', city: 'Arequipa', regionId: 'ARE' },
  { id: 'U3', name: 'Universidad Chan Chan del Norte (ficticia)', city: 'Trujillo', regionId: 'LAL' },
] as const;

export const CAREERS = [
  ['SIS', 'Ingeniería de Sistemas'],
  ['ENF', 'Enfermería'],
  ['EDU', 'Educación Primaria'],
  ['CON', 'Contabilidad'],
] as const;

type CourseTpl = { code: string; name: string; credits: number; topics: Record<string, string> };

/** Cursos del primer ciclo: comunes + propios de la carrera. NIV es un módulo de nivelación que cierra en la semana 4. */
export const COMMON_COURSES: CourseTpl[] = [
  { code: 'NIV', name: 'Nivelación en Matemática', credits: 2, topics: { '1': 'Fracciones y proporciones', '2': 'Ecuaciones lineales', '3': 'Funciones', '4': 'Examen final del módulo' } },
  { code: 'MAT', name: 'Matemática Básica', credits: 4, topics: { '5': 'Funciones lineales y cuadráticas', '6': 'Sistemas de ecuaciones', '7': 'Desigualdades' } },
  { code: 'COM', name: 'Comunicación y Redacción', credits: 3, topics: { '5': 'El párrafo argumentativo', '6': 'Citado y fuentes', '7': 'El ensayo breve' } },
  { code: 'MET', name: 'Métodos de Estudio Universitario', credits: 2, topics: { '5': 'Planificación semanal', '6': 'Técnicas de lectura', '7': 'Preparación de exámenes' } },
];

export const CAREER_COURSES: Record<string, CourseTpl[]> = {
  SIS: [
    { code: 'PRG', name: 'Programación I', credits: 4, topics: { '5': 'Condicionales', '6': 'Bucles', '7': 'Funciones' } },
    { code: 'FIS', name: 'Física I', credits: 4, topics: { '5': 'Cinemática', '6': 'Leyes de Newton', '7': 'Trabajo y energía' } },
    { code: 'ICS', name: 'Introducción a la Ingeniería de Sistemas', credits: 3, topics: { '5': 'Pensamiento sistémico', '6': 'Procesos', '7': 'Proyecto integrador' } },
  ],
  ENF: [
    { code: 'BIO', name: 'Biología Celular', credits: 4, topics: { '5': 'La célula', '6': 'Membrana y transporte', '7': 'Metabolismo' } },
    { code: 'ANA', name: 'Anatomía I', credits: 4, topics: { '5': 'Sistema óseo', '6': 'Sistema muscular', '7': 'Sistema nervioso' } },
    { code: 'IEN', name: 'Introducción a la Enfermería', credits: 3, topics: { '5': 'Historia del cuidado', '6': 'Ética del cuidado', '7': 'Bioseguridad' } },
  ],
  EDU: [
    { code: 'PSI', name: 'Psicología del Desarrollo', credits: 4, topics: { '5': 'Desarrollo cognitivo', '6': 'Desarrollo socioemocional', '7': 'Lenguaje' } },
    { code: 'DID', name: 'Didáctica General', credits: 4, topics: { '5': 'Planificación curricular', '6': 'Estrategias', '7': 'Evaluación' } },
    { code: 'REA', name: 'Realidad Educativa Peruana', credits: 3, topics: { '5': 'Educación rural', '6': 'Interculturalidad', '7': 'Políticas educativas' } },
  ],
  CON: [
    { code: 'CGE', name: 'Contabilidad General', credits: 4, topics: { '5': 'Plan contable', '6': 'Asientos', '7': 'Balance de comprobación' } },
    { code: 'ECO', name: 'Economía General', credits: 4, topics: { '5': 'Oferta y demanda', '6': 'Elasticidad', '7': 'Mercados' } },
    { code: 'ADM', name: 'Fundamentos de Administración', credits: 3, topics: { '5': 'La empresa', '6': 'Planeamiento', '7': 'Organización' } },
  ],
};

/** Kit de llegada. Pendientes genéricos: el detalle remite a canales oficiales (no se inventan procedimientos). */
export const CHECKLIST = [
  { id: 'VIV-1', category: 'Vivienda', title: 'Confirmar dónde vivirás y tener un acuerdo por escrito', detail: 'Bienestar universitario puede orientarte sobre alojamientos y contratos.', dueDays: 7 },
  { id: 'VIV-2', category: 'Vivienda', title: 'Ubicar el centro de salud más cercano', detail: 'Anota dirección y horario; guárdalo en tu celular.', dueDays: 14 },
  { id: 'TRA-1', category: 'Transporte', title: 'Planificar tu ruta casa–universidad', detail: 'Haz el recorrido una vez antes del primer día y calcula el tiempo.', dueDays: 3 },
  { id: 'TRA-2', category: 'Transporte', title: 'Tramitar el medio pasaje universitario', detail: 'Se gestiona con tu carné universitario.', dueDays: 21 },
  { id: 'DEP-1', category: 'Depósitos', title: 'Revisar la fecha de depósito de tu subvención', detail: 'Consulta el calendario oficial en el portal del becario de Pronabec.', dueDays: 7 },
  { id: 'DEP-2', category: 'Depósitos', title: 'Activar la cuenta donde recibes la subvención', detail: 'Sigue las indicaciones oficiales de Pronabec para tu cuenta.', dueDays: 10 },
  { id: 'TRM-1', category: 'Trámites', title: 'Activar tu correo y aula virtual institucional', detail: 'Lo necesitas para clases y notas.', dueDays: 3 },
  { id: 'TRM-2', category: 'Trámites', title: 'Obtener tu carné universitario', detail: 'Consulta en registros académicos de tu universidad.', dueDays: 21 },
  { id: 'TRM-3', category: 'Trámites', title: 'Registrar un contacto de emergencia', detail: 'Hazlo en tu perfil de la universidad y en Acompaña.', dueDays: 7 },
];

export const FIRST_NAMES_F = ['María', 'Rosa', 'Lucía', 'Carmen', 'Ana', 'Milagros', 'Yesenia', 'Flor', 'Diana', 'Katherine', 'Sofía', 'Valeria', 'Nayeli', 'Ruth', 'Gladys', 'Mariela'];
export const FIRST_NAMES_M = ['José', 'Luis', 'Juan', 'Carlos', 'Jorge', 'Miguel', 'Edwin', 'Wilmer', 'Kevin', 'Brayan', 'Diego', 'Alex', 'Renzo', 'Elmer', 'Hugo', 'Percy'];
export const LAST_NAMES = ['Quispe', 'Mamani', 'Huamán', 'Flores', 'Condori', 'Ccama', 'Rojas', 'Chávez', 'Ramos', 'Torres', 'Vargas', 'Gutiérrez', 'Sánchez', 'Cruz', 'Apaza', 'Yupanqui', 'Ticona', 'Pacheco', 'Salazar', 'Paredes'];
